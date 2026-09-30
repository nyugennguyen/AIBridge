/**
 * M4.9 — the transport seam's node-facing half.
 *
 * Two things live here and neither is a fault:
 *
 *   - **Identity.** Real ed25519 keys, a real trust store, a real pin store and a
 *     real replay guard, so every record the proxy moves is signed by the sender
 *     and verified by the receiver through M4.2's own `MeshIdentityProvider`. A
 *     harness that skipped signatures would exercise routing and none of the
 *     identity, which is most of what M4.2 is for.
 *   - **The signature scope.** The inbox's authenticator is a PORT that receives
 *     the record and nothing else, so the signature has to travel beside it.
 *     `AsyncLocalStorage` is what carries it, for the reason
 *     `tests/integration/mesh-fixtures.ts` gives: one shared field on the node
 *     would be read by whichever submission happened to be in flight.
 *
 * Nonces are a per-node COUNTER rather than a random source. A nonce's whole job
 * is to be unique per node per request so the replay guard has something to
 * consume, and a counter is unique by construction without a random source the
 * harness would then have to make reproducible anyway.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { MeshId, NodeId } from "../../orchestration/identifiers.js"
import {
  InMemoryEnrollmentCodeStore,
  InMemoryNodeTrustStore,
  InMemoryNonceGuard,
  InMemoryPeerKeyPinStore,
  MeshIdentityProvider,
  NodeKeyPair,
  meshBodyDigest,
  publicNodeKeyOf,
  signMeshRequest,
  type MeshRequestSignature,
} from "../identity/index.js"
import type { FaultClock, InboundRequest } from "./types.js"
import type { ProxySendInput } from "./proxy.js"

const requestSignatures = new AsyncLocalStorage<MeshRequestSignature>()

/** Runs `work` with an inbound request's signature readable by the node's seams. */
export function withRequestSignature<T>(signature: MeshRequestSignature, work: () => T): T {
  return requestSignatures.run(signature, work)
}

/** The signature in scope, or `undefined` outside a request. */
export function currentRequestSignature(): MeshRequestSignature | undefined {
  return requestSignatures.getStore()
}

/** One node's identity half. */
export interface NodeIdentity {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly keyPair: NodeKeyPair
  readonly trust: InMemoryNodeTrustStore
  readonly pins: InMemoryPeerKeyPinStore
  readonly codes: InMemoryEnrollmentCodeStore
  readonly provider: MeshIdentityProvider
  /** Signs one request over the real target, with a fresh nonce. */
  sign(method: string, path: string, body: unknown, nowMs: number): MeshRequestSignature
  /** Trusts and pins a peer, which is what makes that peer's records attributable. */
  admitPeer(peer: { readonly nodeId: NodeId; readonly keyPair: NodeKeyPair }, nowMs: number): Promise<void>
}

export function aNodeIdentity(nodeId: NodeId, clock: FaultClock, meshId: MeshId): NodeIdentity {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: clock.now })
  const codes = new InMemoryEnrollmentCodeStore()
  let nonce = 0

  const identity: NodeIdentity = {
    nodeId,
    meshId,
    keyPair,
    trust,
    pins,
    codes,
    provider,
    sign: (method, path, body, nowMs) => {
      nonce += 1
      const bytes = Buffer.alloc(32)
      bytes.writeUInt32BE(nonce, 0)
      bytes.write(String(nodeId), 4, "utf8")
      return signMeshRequest(keyPair, {
        method,
        path,
        bodyDigest: meshBodyDigest(body),
        timestamp: nowMs,
        nonce: bytes.toString("base64url"),
        nodeId,
        keyId: keyPair.keyId,
      })
    },
    admitPeer: async (peer, nowMs) => {
      await trust.enroll({
        nodeId: peer.nodeId,
        meshId,
        nodeKeyId: peer.keyPair.keyId,
        enrolledAt: nowMs,
        displayName: String(peer.nodeId),
      })
      await pins.pin({
        nodeId: peer.nodeId,
        meshId,
        key: publicNodeKeyOf(peer.keyPair),
        enrollmentId: `enr-admit-${String(peer.nodeId)}`,
        now: nowMs,
      })
    },
  }
  return identity
}

/** What a node needs from the proxy in order to send. */
export type ProxySubmit = (input: ProxySendInput) => Promise<unknown>

/**
 * A node's outbound surface: sign, then hand to the proxy.
 *
 * The signature is minted HERE, at send time, against the current reading of the
 * injected clock — not at record-construction time. A signature stamped when the
 * record was built would already be aged by the time a `delay` fault let it
 * through, and a delay fault that made every delayed record unauthentic would be
 * testing the replay window rather than the delay.
 */
export interface NodeTransportContext {
  readonly identity: NodeIdentity
  readonly clock: FaultClock
  readonly submit: ProxySubmit
  send(input: {
    readonly from: NodeId
    readonly to: NodeId
    readonly record: unknown
    readonly method?: string
    readonly path?: string
  }): Promise<unknown>
  withSignature<T>(signature: MeshRequestSignature, work: () => T): T
  /** The signature in scope, or `undefined` outside a request. */
  currentSignature(): MeshRequestSignature | undefined
}

export function aTransportContext(input: {
  readonly identity: NodeIdentity
  readonly clock: FaultClock
  readonly submit: ProxySubmit
}): NodeTransportContext {
  const { identity, clock, submit } = input
  return {
    identity,
    clock,
    submit,
    send: (sendInput) => {
      const method = sendInput.method ?? "POST"
      const path = sendInput.path ?? defaultPathFor(sendInput.record)
      return submit({
        from: sendInput.from,
        to: sendInput.to,
        record: sendInput.record,
        signature: identity.sign(method, path, sendInput.record, clock.now()),
        // Each retransmitted copy is signed afresh: a retransmission is a NEW
        // request, and the receiver's replay guard is right to refuse the
        // byte-identical one. See `./proxy.ts` for why that matters.
        resign: () => identity.sign(method, path, sendInput.record, clock.now()),
        method,
        path,
      })
    },
    withSignature: withRequestSignature,
    currentSignature: currentRequestSignature,
  }
}

/**
 * The request target a record is signed over when the caller names none.
 *
 * Derived from the `recordType` so two records of different families can never
 * share a signed target by accident, and so a scenario that overrides the path is
 * overriding something real.
 */
function defaultPathFor(record: unknown): string {
  if (typeof record !== "object" || record === null) return "/v1/mesh/unknown"
  const recordType = (record as { recordType?: unknown }).recordType
  return typeof recordType === "string" ? `/v1/mesh/${recordType.slice("mesh.".length).replace(".", "/")}` : "/v1/mesh/unknown"
}

export type { InboundRequest }

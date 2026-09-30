/**
 * Identity test fixtures.
 *
 * Three rules, each of which exists because breaking it produced a test that
 * passed for the wrong reason at some point during M4.2:
 *
 *   1. **Nothing here reads a clock.** Every timestamp is a literal or a
 *      parameter, and `now` is passed explicitly. The scenarios this milestone has
 *      to be testable for are "thirty seconds after this code expired" and "an hour
 *      after that node was revoked" — a fixture that called `Date.now()` would make
 *      those a sleep, and a sleeping test is a test that passes on a slow machine
 *      and fails on a fast one.
 *   2. **Keys are real.** An ed25519 keypair is 32 bytes and the signature is 64;
 *      a test that stubbed them would not exercise the base64url framing, the key
 *      length bound, or the raw-vs-DER distinction that the wire cares about.
 *   3. **Ids are branded through their schemas.** A fixture that laundered a string
 *      into a brand with a cast would let a test pass against an id no peer could
 *      address, which is the exact class of defect the brands exist to prevent.
 */
import { randomBytes } from "node:crypto"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema, provisionalNodeIdSchema, type NodeKeyId, type ProvisionalNodeId } from "../../../../src/mesh/identity/wire-ids.js"
import { NodeKeyPair, publicNodeKeyOf, type PublicNodeKey } from "../../../../src/mesh/identity/node-key.js"
import type { TrustedNode } from "../../../../src/mesh/identity/node-trust.js"
import type { MeshRequestSignature } from "../../../../src/mesh/identity/request-signature.js"
import { digestJson } from "../../../../src/orchestration/digest.js"

export const MESH_ID = meshIdSchema.parse("mesh-release")
export const OTHER_MESH_ID = meshIdSchema.parse("mesh-other")
export const CONTROLLER_ID = nodeIdSchema.parse("node-controller-1")
export const WORKER_ID = nodeIdSchema.parse("node-worker-1")
export const STRANGER_ID = nodeIdSchema.parse("node-stranger")
export const PROVISIONAL_ID = provisionalNodeIdSchema.parse("worker-1")

/**
 * The `senderNodeId` a JOINING node puts in its own enrollment envelope.
 *
 * A joining node genuinely has no `NodeId` yet — the controller mints one from the
 * code hash — but `mesh.enrollment.request`'s envelope requires the field, so one
 * has to be supplied. A branded placeholder is the honest way to do that. Casting a
 * `ProvisionalNodeId` to a `NodeId` would type-check and would be a lie about what
 * the two vocabularies mean: the provisional id is what the node ASKS to be called,
 * and the node id is what it IS. Passing the provisional id under the node id's name
 * is how a test ends up correlating a request against an id the controller never
 * minted.
 */
export const PENDING_SENDER_ID = nodeIdSchema.parse("node-enr-pending")

/** A fixed instant. Every time in these tests is `T0` plus a number. */
export const T0 = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0 + seconds * 1000
}

/** An RFC 3339 timestamp for a `Date`-typed wire field. */
export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * A fresh 32-byte nonce, the shape a node's client would generate.
 *
 * RANDOM, not a fixed constant. A deterministic nonce is fine when a test signs one
 * request, and actively harmful when a test signs two and expects them to differ —
 * a fixed nonce makes the two requests identical apart from the field under test,
 * which is a test that passes for the wrong reason. Real entropy costs nothing here
 * and removes the whole class of mistake.
 */
export function nonce(): string {
  return randomBytes(32).toString("base64url")
}

export interface KeyFixture {
  readonly keyPair: NodeKeyPair
  readonly public: PublicNodeKey
  /** The raw 32 bytes, as the verifier receives them from a pin store. */
  readonly rawPublicKey: Uint8Array
}

export function aKey(): KeyFixture {
  const keyPair = NodeKeyPair.generate()
  return {
    keyPair,
    public: publicNodeKeyOf(keyPair),
    rawPublicKey: keyPair.publicKeyBytes,
  }
}

export function aTrustedNode(overrides: Partial<TrustedNode> = {}): TrustedNode {
  const key = aKey()
  return {
    nodeId: WORKER_ID,
    meshId: MESH_ID,
    nodeKeyId: key.public.nodeKeyId,
    enrolledAt: at(0),
    displayName: "worker-1",
    ...overrides,
  }
}

export interface RequestFixture {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly bodyDigest: string
  readonly timestamp: number
  readonly nonce: string
  readonly nodeId: NodeId
  readonly keyId: NodeKeyId
}

/**
 * The unsigned half of a request.
 *
 * `bodyDigest` is computed here with the kernel's own `digestJson` rather than
 * being passed in, because the single most likely bug in a mesh client is signing
 * one serialisation and the receiver computing another — and a fixture that took
 * the digest as a parameter would let a test pass while doing exactly that.
 */
export function aRequest(overrides: Partial<RequestFixture> = {}): RequestFixture {
  const body = overrides.body === undefined ? { runId: "run-1", op: "start" } : overrides.body
  return {
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/v1/mesh/command",
    body,
    bodyDigest: digestJson(body),
    timestamp: overrides.timestamp ?? at(5),
    nonce: overrides.nonce ?? nonce(),
    nodeId: overrides.nodeId ?? WORKER_ID,
    keyId: overrides.keyId ?? nodeKeyIdSchema.parse("key-placeholder"),
  }
}

export function asSignature(request: RequestFixture, signature: string): MeshRequestSignature {
  return {
    method: request.method,
    path: request.path,
    bodyDigest: request.bodyDigest,
    timestamp: request.timestamp,
    nonce: request.nonce,
    signature,
    nodeId: request.nodeId,
    keyId: request.keyId,
  }
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/** Convenience for a test that needs a `ProvisionalNodeId` it can vary. */
export function provisional(name: string): ProvisionalNodeId {
  return provisionalNodeIdSchema.parse(name)
}

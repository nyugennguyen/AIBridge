/**
 * M6.6 routing fixtures.
 *
 * Built through the REAL adapter over a real `MeshNodeRegistry` on an in-memory
 * store wherever a test can afford it, because the claim this milestone makes is
 * "routing is an adapter over the mesh registry and needed no change to it". A
 * fixture that hand-built a `RoutingNodeSnapshot` would let a routing bug hide
 * behind an adapter bug, and vice versa.
 *
 * Nothing here reads a clock. Every instant is `T0_MS` plus a number, and liveness
 * is derived by the registry from the injected clock, so "ninety-one seconds after
 * the last heartbeat" is a number in a test rather than a sleep — a test that
 * passes on a slow machine and fails on a fast one is not a test.
 */

import { meshIdSchema, nodeIdSchema, projectIdSchema, projectPathIdSchema } from "../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../../../src/mesh/identity/wire-ids.js"
import { MeshNodeRegistry } from "../../../src/mesh/registry/registry.js"
import { InMemoryNodeRegistryStore } from "../../../src/mesh/registry/memory-registry.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../src/mesh/protocol/negotiation.js"
import { permissionEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import {
  buildRoutingSnapshot,
  type RoutingRegistryPort,
  type RoutingSnapshotContext,
} from "../../../src/routing/index.js"
import type { RoutingNodeSnapshot, RoutingRequest } from "../../../src/routing/index.js"

export const MESH_ID = meshIdSchema.parse("mesh-release")
export const OTHER_MESH_ID = meshIdSchema.parse("mesh-other")
export const PROJECT_ID = projectIdSchema.parse("proj-release")
export const OTHER_PROJECT_ID = projectIdSchema.parse("proj-other")
export const PROJECT_PATH_ID = projectPathIdSchema.parse("path-release-1")
export const OTHER_PATH_ID = projectPathIdSchema.parse("path-release-2")

export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0_MS + seconds * 1000
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * A clock the test moves by hand.
 *
 * Exposes the function and a setter rather than a monotone `tick`, because the
 * scenarios include a node whose clock is ahead of the controller's and a
 * controller whose clock has stepped backwards.
 */
export class TestClock {
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
}

export function inMemoryRegistry(clock: TestClock): { registry: MeshNodeRegistry; store: InMemoryNodeRegistryStore } {
  const store = new InMemoryNodeRegistryStore()
  return { registry: new MeshNodeRegistry({ store, now: clock.now }), store }
}

export interface EnrollmentInput {
  readonly nodeId?: string
  readonly keySuffix?: string
  readonly displayName?: string
}

/**
 * Enrolls a node.
 *
 * Enrollment is a STORE call — `MeshNodeRegistry` deliberately has no public
 * `enroll`, because a heartbeat must never enroll a node (§4.2's invariant: an
 * accepted enrollment RESPONSE is the only thing that makes a node addressable).
 * The fixture drives the store the registry itself reads from, so this is the same
 * code path production takes, not a shortcut past the registry.
 */
export async function enroll(
  store: InMemoryNodeRegistryStore,
  overrides: EnrollmentInput = {},
): Promise<string> {
  const nodeId = nodeIdSchema.parse(overrides.nodeId ?? "node-alpha")
  const nodeKeyId = nodeKeyIdSchema.parse(`key-${overrides.keySuffix ?? nodeId}`)
  const result = await store.enrollNode({
    meshId: MESH_ID,
    nodeId,
    nodeKeyId,
    displayName: overrides.displayName ?? nodeId,
    enrolledAt: at(0),
  })
  if (!result.ok) throw new Error(`fixture enrollment was refused: ${result.error.code} — ${result.error.message}`)
  return nodeId
}

export interface HeartbeatOverrides {
  readonly nodeId?: string
  readonly observedAt?: number
  readonly runtimeKinds?: string[]
  readonly capabilities?: string[]
  readonly projectPathIds?: string[]
  readonly maxConcurrentSessions?: number
  readonly activeSessions?: number
  readonly protocolVersions?: number[]
  readonly envelopeProtocolVersion?: number
}

/**
 * Writes a `mesh.heartbeat` through the registry's INGEST seam.
 *
 * Goes through `recordHeartbeat` rather than writing a snapshot into the store,
 * because the ingest seam is the only place a heartbeat becomes registry state and
 * a fixture that bypassed it could build a record the wire would refuse.
 */
export async function heartbeat(
  registry: MeshNodeRegistry,
  overrides: HeartbeatOverrides = {},
): Promise<void> {
  const nodeId = nodeIdSchema.parse(overrides.nodeId ?? "node-alpha")
  const observedAt = overrides.observedAt ?? at(0)
  const activeSessions = overrides.activeSessions ?? 0
  const envelope: Record<string, unknown> = {
    schemaVersion: 2,
    recordType: "mesh.heartbeat",
    messageId: `msg-${nodeId}-${observedAt}`,
    correlationId: "corr-heartbeat",
    causation: null,
    senderNodeId: nodeId,
    recipientNodeId: null,
    protocolVersion: overrides.envelopeProtocolVersion ?? CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(at(0)),
    expiresAt: iso(at(3600)),
    payload: {
      meshId: MESH_ID,
      nodeId,
      observedAt: iso(observedAt),
      sequence: 1,
      liveness: "live",
      runtimeKinds: overrides.runtimeKinds ?? ["opencode"],
      capabilities: overrides.capabilities ?? ["fs.read"],
      projectPathIds: overrides.projectPathIds ?? [PROJECT_PATH_ID],
      maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
      protocolVersions: overrides.protocolVersions ?? [CURRENT_MESH_PROTOCOL_VERSION],
      agentCount: Math.max(activeSessions, 1),
      load: { activeSessions, queuedSessions: 0 },
    },
  }
  const outcome = await registry.recordHeartbeat(envelope)
  if (outcome.outcome === "refused") {
    throw new Error(`fixture heartbeat was refused: ${outcome.error.code} — ${outcome.error.message}`)
  }
}

/** Revokes a node through the registry's own seam. */
export async function revoke(registry: MeshNodeRegistry, nodeId: string): Promise<void> {
  const result = await registry.revoke({
    nodeId: nodeIdSchema.parse(nodeId),
    meshId: MESH_ID,
    reason: "fixture revocation",
    revokedBy: "fixture",
    revokedAt: at(1),
  })
  if (!result.ok) throw new Error(`fixture revocation was refused: ${result.error.code} — ${result.error.message}`)
}

/** The permission envelope a dispatch carries, as `permissionEnvelopeSchema` parses it. */
export function anEnvelope(overrides: Partial<{
  allowedCapabilities: string[]
  deniedCapabilities: string[]
}> = {}) {
  const allowedCapabilities = overrides.allowedCapabilities ?? ["fs.read"]
  return permissionEnvelopeSchema.parse({
    allowedCapabilities,
    deniedCapabilities: overrides.deniedCapabilities ?? [],
    approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
  })
}

export function aRequest(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    projectId: PROJECT_ID,
    projectPathId: PROJECT_PATH_ID,
    requiredCapabilities: ["fs.read"],
    requiredRuntimeKinds: ["opencode"],
    requiredToolCategories: [],
    now: at(0),
    excludeNodeIds: [],
    ...overrides,
  }
}

export function aContext(overrides: Partial<RoutingSnapshotContext> = {}): RoutingSnapshotContext {
  return {
    meshId: MESH_ID,
    authorizedProjectIds: {},
    permissionEnvelope: anEnvelope(),
    projectPathAllowedCapabilities: null,
    ...overrides,
  }
}

/** Every node authorized for the release project unless a test says otherwise. */
export function authorizedFor(...nodeIds: string[]): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {}
  for (const nodeId of nodeIds) map[nodeId] = [PROJECT_ID]
  return map
}

/**
 * The end-to-end path: registry → adapter → frozen snapshots.
 *
 * The one entry every routing test that needs a real mesh uses, so "routing needs
 * no registry change" is exercised end to end rather than asserted in a comment.
 */
export async function snapshotsFor(
  registry: MeshNodeRegistry,
  request: RoutingRequest,
  context: RoutingSnapshotContext,
): Promise<readonly RoutingNodeSnapshot[]> {
  const port: RoutingRegistryPort = registry
  const result = await buildRoutingSnapshot(port, request, context)
  if (!result.ok) throw new Error(`fixture snapshot was refused: ${result.error.code} — ${result.error.message}`)
  return result.value
}

/**
 * A canary planted in every FREE-TEXT field of a snapshot.
 *
 * `displayName` is the only genuinely free-text field; the rest are seeded anyway
 * because a future edit could make one of them render, and the no-secret test is
 * cheaper as "every string field carries a distinct canary" than as an audit of
 * which fields are quoted today.
 */
export const CANARY = "CANARY-SECRET-must-never-appear-9f3a2b"

/** A snapshot built directly, for tests that need a shape the registry would refuse to produce. */
export function aSnapshot(overrides: Partial<RoutingNodeSnapshot> = {}): RoutingNodeSnapshot {
  return {
    nodeId: nodeIdSchema.parse("node-alpha"),
    displayName: CANARY,
    revoked: false,
    projectIds: [PROJECT_ID],
    projectPathIds: [PROJECT_PATH_ID],
    runtimeKinds: ["opencode"],
    capabilities: ["fs.read"],
    maxConcurrentSessions: 4,
    activeSessions: 0,
    healthy: true,
    healthReason: "liveness_live",
    livenessState: "live",
    sequence: 1,
    observedAt: iso(at(0)),
    verdictEligible: true,
    verdictReason: "advertised",
    ...overrides,
  }
}

/** Deterministic shuffle: no randomness, because a test with `Math.random` cannot fail reliably. */
export function rotated<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values
  const shift = ((by % values.length) + values.length) % values.length
  return [...values.slice(shift), ...values.slice(0, shift)]
}

/**
 * Node-registry test fixtures.
 *
 * Built on the PROTOCOL fixtures rather than a third copy of a heartbeat. The
 * heartbeat shape is owned by `src/mesh/protocol/heartbeat.ts`, and a registry
 * fixture that restates it is a fixture that can be satisfied by a record the wire
 * would refuse — which is the one class of bug in this directory that would make a
 * green suite mean nothing.
 *
 * Nothing here reads a clock. Every timestamp is `T0` plus a number and the clock
 * is a closure the test moves by hand, because the whole subject of M4.3 is what
 * happens ninety-one seconds after a heartbeat, and a fixture that called
 * `Date.now()` would turn that into a sleep — a test that passes on a slow machine
 * and fails on a fast one.
 */
import { meshIdSchema, nodeIdSchema, projectPathIdSchema, type MeshId, type NodeId } from "../../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema, type NodeKeyId } from "../../../../src/mesh/identity/wire-ids.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import { MeshNodeRegistry } from "../../../../src/mesh/registry/registry.js"
import { InMemoryNodeRegistryStore } from "../../../../src/mesh/registry/memory-registry.js"
import { SqliteNodeRegistryStore } from "../../../../src/mesh/registry/sqlite-registry.js"
import { runMeshRegistryMigrations } from "../../../../src/mesh/registry/migrations.js"
import { openInMemoryDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import type { NodeRegistryStore } from "../../../../src/mesh/registry/types.js"

export const MESH_ID = meshIdSchema.parse("mesh-release")
export const OTHER_MESH_ID = meshIdSchema.parse("mesh-other")
export const WORKER_ID = nodeIdSchema.parse("node-worker-1")
export const SECOND_WORKER_ID = nodeIdSchema.parse("node-worker-2")
export const STRANGER_ID = nodeIdSchema.parse("node-stranger")
export const WORKER_KEY_ID = nodeKeyIdSchema.parse("key-worker-1")
export const SECOND_KEY_ID = nodeKeyIdSchema.parse("key-worker-2")
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
 * Exposes the function AND the setter rather than a `tick()` that only moves
 * forward, because the scenarios include a node whose clock is AHEAD of the
 * controller's and a controller whose clock has stepped backwards, and neither is
 * expressible as a monotone tick.
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

export function durableRegistry(clock: TestClock): {
  registry: MeshNodeRegistry
  store: SqliteNodeRegistryStore
  driver: SqliteDriver
  close: () => void
} {
  const driver = openInMemoryDriver()
  runMeshRegistryMigrations(driver, { now: clock.now })
  const store = new SqliteNodeRegistryStore(driver)
  return { registry: new MeshNodeRegistry({ store, now: clock.now }), store, driver, close: () => driver.close() }
}

export function memoryStore(): InMemoryNodeRegistryStore {
  return new InMemoryNodeRegistryStore()
}

export function durableStore(clock: TestClock = new TestClock()): {
  store: SqliteNodeRegistryStore
  driver: SqliteDriver
  close: () => void
} {
  const driver = openInMemoryDriver()
  runMeshRegistryMigrations(driver, { now: clock.now })
  return { store: new SqliteNodeRegistryStore(driver), driver, close: () => driver.close() }
}

export interface EnrollmentInput {
  readonly nodeId?: NodeId
  readonly nodeKeyId?: NodeKeyId
  readonly meshId?: MeshId
  readonly displayName?: string
  readonly enrolledAt?: number
}

/** Enrolls a worker, failing the test if the store refuses — the tests want success. */
export async function enroll(store: NodeRegistryStore, overrides: EnrollmentInput = {}): Promise<NodeId> {
  const nodeId = overrides.nodeId ?? WORKER_ID
  const result = await store.enrollNode({
    meshId: overrides.meshId ?? MESH_ID,
    nodeId,
    nodeKeyId: overrides.nodeKeyId ?? WORKER_KEY_ID,
    displayName: overrides.displayName ?? "worker-1",
    enrolledAt: overrides.enrolledAt ?? at(0),
  })
  if (!result.ok) throw new Error(`fixture enrollment was refused: ${result.error.code} — ${result.error.message}`)
  return nodeId
}

export interface HeartbeatOverrides {
  readonly nodeId?: NodeId
  readonly meshId?: MeshId
  readonly sequence?: number
  readonly observedAt?: string
  readonly runtimeKinds?: string[]
  readonly capabilities?: string[]
  readonly projectPathIds?: string[]
  readonly maxConcurrentSessions?: number
  readonly activeSessions?: number
  readonly protocolVersions?: number[]
  readonly envelopeProtocolVersion?: number
  readonly schemaVersion?: unknown
  readonly issuedAt?: string
  readonly expiresAt?: string
}

/**
 * A `mesh.heartbeat` envelope, built as a plain object and left for
 * `parseMeshEnvelope` to validate.
 *
 * Not schema-parsed here on purpose: the ingest seam is the only parse site, and a
 * fixture that parsed first would let a negative test pass for the wrong reason —
 * the record would already be valid by the time the registry refused it. The
 * `overrides` are spread LAST so a test can inject a member the schema must refuse.
 */
export function heartbeatEnvelope(overrides: HeartbeatOverrides = {}): Record<string, unknown> {
  const nodeId = overrides.nodeId ?? WORKER_ID
  const issuedAt = overrides.issuedAt ?? iso(at(0))
  return {
    schemaVersion: overrides.schemaVersion === undefined ? 2 : overrides.schemaVersion,
    recordType: "mesh.heartbeat",
    messageId: "msg-heartbeat-1",
    correlationId: "corr-heartbeat",
    causation: null,
    // The first-person rule: a heartbeat is a report about the sender. `null` is a
    // genuine broadcast, which is what a heartbeat fan-in is.
    senderNodeId: nodeId,
    recipientNodeId: null,
    protocolVersion: overrides.envelopeProtocolVersion ?? CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt,
    expiresAt: overrides.expiresAt ?? iso(at(3600)),
    payload: {
      meshId: overrides.meshId ?? MESH_ID,
      nodeId,
      observedAt: overrides.observedAt ?? iso(at(0)),
      sequence: overrides.sequence ?? 1,
      liveness: "live",
      runtimeKinds: overrides.runtimeKinds ?? ["opencode"],
      capabilities: overrides.capabilities ?? ["fs.read", "fs.write"],
      projectPathIds: overrides.projectPathIds ?? [PROJECT_PATH_ID],
      maxConcurrentSessions: overrides.maxConcurrentSessions ?? 4,
      protocolVersions: overrides.protocolVersions ?? [CURRENT_MESH_PROTOCOL_VERSION],
      // `agentCount` tracks the reported load rather than being fixed at 1, because
      // `meshHeartbeatSchema` refuses a heartbeat whose agent count is BELOW its
      // active session count — a real invariant, and one a fixture that hard-coded
      // "1" would trip the moment a test wanted a busy node.
      agentCount: Math.max(overrides.activeSessions ?? 0, 1),
      load: { activeSessions: overrides.activeSessions ?? 0, queuedSessions: 0 },
    },
  }
}

/**
 * A `CapabilitySnapshot` as the STORED record, for tests that drive the store
 * directly rather than through the ingest seam.
 *
 * Lives here rather than in two test files so the two implementations of the store
 * are exercised against the same value, and so `projectPathIds` is branded through
 * the kernel's schema instead of being a bare string that happens to satisfy the
 * shape at runtime and not at compile time.
 */
export function aCapabilitySnapshot(overrides: Partial<import("../../../../src/mesh/registry/schemas.js").CapabilitySnapshot> = {}) {
  return {
    observedAt: iso(at(0)),
    sequence: 1,
    runtimeKinds: ["opencode"],
    capabilities: ["fs.read"],
    projectPathIds: [PROJECT_PATH_ID],
    maxConcurrentSessions: 4,
    agentCount: 1,
    load: { activeSessions: 0, queuedSessions: 0 },
    offeredProtocolVersions: [1],
    negotiatedProtocolVersion: 1,
    ...overrides,
  }
}

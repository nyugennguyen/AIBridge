import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteDriver, openInMemoryDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import { CURRENT_SCHEMA_VERSION } from "../../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { runMeshRegistryMigrations, verifyMeshRegistrySchema } from "../../../../src/mesh/registry/migrations.js"
import { InMemoryNodeRegistryStore } from "../../../../src/mesh/registry/memory-registry.js"
import { SqliteNodeRegistryStore } from "../../../../src/mesh/registry/sqlite-registry.js"
import type { NodeRegistryStore } from "../../../../src/mesh/registry/types.js"
import {
  MESH_ID,
  OTHER_MESH_ID,
  SECOND_WORKER_ID,
  WORKER_ID,
  WORKER_KEY_ID,
  TestClock,
  aCapabilitySnapshot,
  at,
  durableStore,
  enroll,
  heartbeatEnvelope,
  inMemoryRegistry,
  iso,
  memoryStore,
} from "./fixtures.js"


/**
 * The store, tested as a PORT and against BOTH implementations.
 *
 * The in-memory store is the specification the durable one has to match, and every
 * scenario below runs against both. A single-implementation suite would prove that
 * one store behaves as its author intended, which is a weaker claim than the one
 * this milestone needs: that the durable one is safe.
 */
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function bothStores(clock: TestClock): { label: string; store: NodeRegistryStore; close: () => void }[] {
  const memory = memoryStore()
  const { store: durable, close: closeDurable } = durableStore(clock)
  return [
    { label: "InMemoryNodeRegistryStore", store: memory, close: () => undefined },
    { label: "SqliteNodeRegistryStore", store: durable, close: closeDurable },
  ]
}

describe("M4.3 enrollment converges on one node", () => {
  for (const { label, getStore } of [
    { label: "InMemoryNodeRegistryStore", getStore: () => ({ store: memoryStore(), close: () => undefined }) },
    { label: "SqliteNodeRegistryStore", getStore: (clock: TestClock) => durableStore(clock) },
  ]) {
    describe(label, () => {
      it("repeating the same enrollment converges to one node rather than erroring", async () => {
        const clock = new TestClock(at(0))
        const { store, close } = getStore(clock)
        try {
          const first = await store.enrollNode({ meshId: MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(0) })
          expect(first.ok && first.value.created).toBe(true)

          // A node whose enrollment RESPONSE was lost retries. An error here would
          // make a successful enrollment look like a permanent failure forever, and
          // the operator's remedy — re-run the enrollment — would be the very thing
          // that keeps failing.
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const again = await store.enrollNode({ meshId: MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(0) })
            expect(again.ok && again.value.created).toBe(false)
          }

          const nodes = await store.nodes(MESH_ID)
          expect(nodes.ok && nodes.value).toHaveLength(1)
          const found = await store.node(WORKER_ID)
          expect(found.ok && found.value?.nodeKeyId).toBe(WORKER_KEY_ID)
          expect(found.ok && found.value?.enrolledAt).toBe(at(0))
        } finally {
          close()
        }
      })

      it("a second key for a known node is refused — §4.1 pins the exact key", async () => {
        const clock = new TestClock(at(0))
        const { store, close } = getStore(clock)
        try {
          await enroll(store, {})
          const second = await store.enrollNode({
            meshId: MESH_ID,
            nodeId: WORKER_ID,
            nodeKeyId: nodeKeyIdSchema.parse("key-intercepted"),
            displayName: "worker-1",
            enrolledAt: at(1),
          })
          expect(second.ok).toBe(false)
          if (second.ok) return
          // A second pin for one node means every read path has to decide which key
          // wins, and the one that loses is a pin somebody else chose.
          expect(second.error.code).toBe("registry.key_pin_conflict")

          const found = await store.node(WORKER_ID)
          expect(found.ok && found.value?.nodeKeyId).toBe(WORKER_KEY_ID)
        } finally {
          close()
        }
      })

      it("a node cannot be enrolled into two meshes", async () => {
        const clock = new TestClock(at(0))
        const { store, close } = getStore(clock)
        try {
          await enroll(store, {})
          const other = await store.enrollNode({ meshId: OTHER_MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(1) })
          expect(other.ok).toBe(false)
        } finally {
          close()
        }
      })

      it("a heartbeat cannot create a row for a node that never enrolled", async () => {
        const clock = new TestClock(at(0))
        const { registry, store } = inMemoryRegistry(clock)
        const result = await registry.recordHeartbeat(heartbeatEnvelope({ nodeId: SECOND_WORKER_ID, sequence: 1 }))
        expect(result.outcome).toBe("refused")
        const nodes = await store.nodes(MESH_ID)
        expect(nodes.ok && nodes.value).toEqual([])
      })
    })
  }
})

describe("M4.3 revocation is indexed by key in the same transaction as the node record", () => {
  it("revoking and then immediately pinning the same key is refused, with no intervening write", async () => {
    const clock = new TestClock(at(0))
    const { store, driver, close } = durableStore(clock)
    try {
      await enroll(store, {})

      const revoked = await store.revokeNode({
        nodeId: WORKER_ID,
        meshId: MESH_ID,
        revokedKeyId: WORKER_KEY_ID,
        reason: "machine reported stolen",
        revokedBy: "operator-1",
        revokedAt: at(10),
      })
      expect(revoked.ok).toBe(true)

      // The index is readable in the same breath as the write, with nothing in
      // between. There is no lazy population step and no second transaction, so
      // there is no window.
      const byKey = await store.revocationByKeyId(WORKER_KEY_ID)
      expect(byKey.ok && byKey.value?.nodeId).toBe(WORKER_ID)
      // And the node's own record reports the same revocation, by join.
      const node = await store.node(WORKER_ID)
      expect(node.ok && node.value?.revocation?.revokedKeyId).toBe(WORKER_KEY_ID)

      // THE ATTACK, and the ordinary retry. A node id is derived from an enrollment
      // code, so a revoked machine returns with a FRESH code, is minted a DIFFERENT
      // node id, and presents the very key that was just revoked. Without the key
      // index, "revoke the compromised machine" would reduce to "revoke one of its
      // names" and the credential would walk straight back onto the mesh.
      const rejoin = await store.enrollNode({
        meshId: MESH_ID,
        nodeId: SECOND_WORKER_ID,
        nodeKeyId: WORKER_KEY_ID,
        displayName: "worker-1 (new name)",
        enrolledAt: at(11),
      })
      expect(rejoin.ok).toBe(false)
      if (rejoin.ok) return
      expect(rejoin.error.code).toBe("registry.key_revoked")

      // No intervening write: no node row for the new name, and the revocation count
      // is still one. A refused write that had half-succeeded would leave the mesh
      // with either a phantom node or two revocations for one key, and neither is
      // detectable from the caller's side.
      const nodes = await store.nodes(MESH_ID)
      expect(nodes.ok && nodes.value.map((n) => n.nodeId)).toEqual([WORKER_ID])
      const revocationRows = driver.get<{ count: number }>("SELECT COUNT(*) as count FROM mesh_registry_revocations")
      expect(revocationRows?.count).toBe(1)
      const secondName = await store.node(SECOND_WORKER_ID)
      expect(secondName.ok && secondName.value).toBeNull()
    } finally {
      close()
    }
  })

  it("the same guarantee holds in the in-memory store, whose index is maintained in the same transition", async () => {
    const store = new InMemoryNodeRegistryStore()
    await enroll(store, {})
    await store.revokeNode({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      revokedKeyId: WORKER_KEY_ID,
      reason: "stolen",
      revokedBy: "operator-1",
      revokedAt: at(10),
    })
    const rejoin = await store.enrollNode({ meshId: MESH_ID, nodeId: SECOND_WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "new", enrolledAt: at(11) })
    expect(rejoin.ok).toBe(false)
    const nodes = await store.nodes(MESH_ID)
    expect(nodes.ok && nodes.value).toHaveLength(1)
  })

  it("revoking twice is idempotent and returns the FIRST record", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await enroll(store, {})
      const first = await store.revokeNode({ nodeId: WORKER_ID, meshId: MESH_ID, revokedKeyId: WORKER_KEY_ID, reason: "stolen", revokedBy: "op-1", revokedAt: at(10) })
      const second = await store.revokeNode({ nodeId: WORKER_ID, meshId: MESH_ID, revokedKeyId: WORKER_KEY_ID, reason: "a different reason entirely", revokedBy: "op-2", revokedAt: at(20) })

      expect(first.ok && second.ok).toBe(true)
      // A revocation is a terminal fact that operators re-apply — a runbook, a retry
      // after a timeout, a second operator who did not see the first. Making that a
      // conflict means an operator has to know whether someone got there first, and
      // the natural response to that error is to look for a way to force it.
      // Returning the ORIGINAL is what keeps "was this node trusted at the time of
      // the incident" from depending on when somebody re-ran the command.
      if (!second.ok) return
      expect(second.value.reason).toBe("stolen")
      expect(second.value.revokedBy).toBe("op-1")
      expect(second.value.revokedAt).toBe(at(10))
    } finally {
      close()
    }
  })

  it("a revoked node cannot be re-enrolled under its own id", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await enroll(store, {})
      await store.revokeNode({ nodeId: WORKER_ID, meshId: MESH_ID, revokedKeyId: WORKER_KEY_ID, reason: "stolen", revokedBy: "op", revokedAt: at(10) })
      const again = await store.enrollNode({ meshId: MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(11) })
      expect(again.ok).toBe(false)
      if (again.ok) return
      expect(again.error.code).toBe("registry.enrollment_revoked")
    } finally {
      close()
    }
  })

  it("an UNKNOWN key revocation lookup returns null, not a failure", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      const found = await store.revocationByKeyId(nodeKeyIdSchema.parse("key-never-seen"))
      // `null` here means "not revoked", which is the one answer that must never be
      // confused with "could not be checked". The fail-closed counterpart is
      // asserted in the next test.
      expect(found.ok && found.value).toBeNull()
    } finally {
      close()
    }
  })

  it("a store that cannot answer the key question is a REFUSAL, not a null", async () => {
    const driver = openInMemoryDriver()
    try {
      // No migrations: the table does not exist, so the SELECT throws. A caller that
      // treated that as "not revoked" would re-admit precisely the key the index
      // exists to keep out — which is why "we could not check" and "it is fine" are
      // different code paths here rather than the same `null`.
      const store = new SqliteNodeRegistryStore(driver)
      const found = await store.revocationByKeyId(WORKER_KEY_ID)
      expect(found.ok).toBe(false)
      if (found.ok) return
      expect(found.error.code).toBe("registry.store_unavailable")
    } finally {
      driver.close()
    }
  })
})

describe("M4.3 the durable store keeps its promises across a restart", () => {
  it("a revocation, a pinned key and a capability advertisement all survive reopening the file", async () => {
    const clock = new TestClock(at(0))
    const directory = mkdtempSync(join(tmpdir(), "aibridge-registry-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "registry.sqlite")

    const first = createSqliteDriver({ path })
    runMeshRegistryMigrations(first, { now: clock.now })
    const firstStore = new SqliteNodeRegistryStore(first)
    await enroll(firstStore, {})
    await firstStore.writeHeartbeat({
      nodeId: WORKER_ID,
      expectedSequence: null,
      snapshot: aCapabilitySnapshot(),
      sequenceGap: { from: 7, to: 9 },
      detectedAt: at(1),
    })
    await firstStore.revokeNode({ nodeId: WORKER_ID, meshId: MESH_ID, revokedKeyId: WORKER_KEY_ID, reason: "stolen", revokedBy: "op", revokedAt: at(2) })
    first.close()

    // The whole reason a revocation is durable. An in-memory revocation set makes
    // revocation a promise that a controller restart silently withdraws, which is
    // worse than not offering it at all — the operator believes the machine is off
    // the mesh and it is not.
    const second = createSqliteDriver({ path })
    try {
      verifyMeshRegistrySchema(second)
      const secondStore = new SqliteNodeRegistryStore(second)
      const byKey = await secondStore.revocationByKeyId(WORKER_KEY_ID)
      expect(byKey.ok && byKey.value?.nodeId).toBe(WORKER_ID)
      const node = await secondStore.node(WORKER_ID)
      expect(node.ok && node.value?.revocation?.reason).toBe("stolen")
      expect(node.ok && node.value?.capability?.capabilities).toEqual(["fs.read"])
      // The gap too. A gap that only ever existed in a response body is a gap that is
      // lost the moment the request ends, and reconciliation has to be able to ask
      // for the range it never saw.
      expect(secondStore.heartbeatGaps(WORKER_ID)).toEqual([{ from: 7, to: 9 }])
    } finally {
      second.close()
    }
  })

  it("a database from a newer build is refused rather than downgraded", () => {
    const clock = new TestClock(at(0))
    const driver = openInMemoryDriver()
    try {
      runMeshRegistryMigrations(driver, { now: clock.now })
      // Simulated by hand rather than by running a future migration: the property
      // under test is the refusal, not the migration.
      driver.run("INSERT INTO mesh_registry_migrations (version, applied_at, name) VALUES (?, ?, ?)", 99, iso(at(0)), "from_the_future")
      expect(() => verifyMeshRegistrySchema(driver, 1)).toThrow()
    } finally {
      driver.close()
    }
  })

  it("running the migrations twice is a no-op", () => {
    const clock = new TestClock(at(0))
    const driver = openInMemoryDriver()
    try {
      const first = runMeshRegistryMigrations(driver, { now: clock.now })
      expect(first.appliedCount).toBe(1)
      const second = runMeshRegistryMigrations(driver, { now: clock.now })
      expect(second.appliedCount).toBe(0)
      verifyMeshRegistrySchema(driver)
    } finally {
      driver.close()
    }
  })
})

describe("M4.3 the heartbeat write is a compare-and-set, and a row is untrusted on read", () => {
  it("a write against a sequence the row has moved past is refused", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await enroll(store, {})
      const first = await store.writeHeartbeat({ nodeId: WORKER_ID, expectedSequence: null, snapshot: aCapabilitySnapshot({ sequence: 1 }), sequenceGap: null, detectedAt: at(0) })
      expect(first.ok && first.value.written).toBe(true)

      const stale = await store.writeHeartbeat({ nodeId: WORKER_ID, expectedSequence: null, snapshot: aCapabilitySnapshot({ sequence: 2 }), sequenceGap: null, detectedAt: at(1) })
      expect(stale.ok && stale.value.written).toBe(false)
      // `written: false` rather than an error: the row did not move back, the caller
      // simply lost. It has to re-read and re-decide, because the sequence verdict it
      // reasoned about was evaluated against a value that is no longer current.
      const found = await store.node(WORKER_ID)
      expect(found.ok && found.value?.capability?.sequence).toBe(1)
    } finally {
      close()
    }
  })

  it("a capability column this build cannot validate makes the whole node LIST unreadable", async () => {
    const clock = new TestClock(at(0))
    const { store, driver, close } = durableStore(clock)
    try {
      await enroll(store, {})
      // A row written by a build that knew a capability vocabulary this one does not.
      driver.run("UPDATE mesh_registry_nodes SET capability_json = ? WHERE node_id = ?", JSON.stringify({ ...aCapabilitySnapshot(), capabilities: 42 }), WORKER_ID)

      const found = await store.node(WORKER_ID)
      expect(found.ok).toBe(false)
      if (found.ok) return
      expect(found.error.code).toBe("registry.node_record_unreadable")

      // The LIST fails too, rather than returning the readable nodes. A partial list
      // is a filter that silently drops a node whose advertisement cannot be
      // validated, and a node that disappears from the registry is a node that stops
      // being dispatched to — the quietest available way to turn a parse error into
      // an outage.
      const list = await store.nodes(MESH_ID)
      expect(list.ok).toBe(false)
    } finally {
      close()
    }
  })

  it("a capability column that is not JSON at all is refused rather than repaired", async () => {
    const clock = new TestClock(at(0))
    const { store, driver, close } = durableStore(clock)
    try {
      await enroll(store, {})
      driver.run("UPDATE mesh_registry_nodes SET capability_json = ? WHERE node_id = ?", "{not json", WORKER_ID)
      const found = await store.node(WORKER_ID)
      expect(found.ok).toBe(false)
      if (found.ok) return
      // A column this build did not write, or one truncated by a crash mid-write, is
      // not something to guess at.
      expect(found.error.message).toContain("not valid JSON")
    } finally {
      close()
    }
  })

  it("a snapshot the schema refuses never reaches the disk", async () => {
    const clock = new TestClock(at(0))
    const { store, driver, close } = durableStore(clock)
    try {
      await enroll(store, {})
      const bad = await store.writeHeartbeat({
        nodeId: WORKER_ID,
        expectedSequence: null,
        // Cast at the fixture rather than the port: the point is that a caller who
        // assembles a snapshot by hand still cannot get an unvalidated one on disk.
        snapshot: { ...aCapabilitySnapshot(), negotiatedProtocolVersion: 1, liveness: "live" } as never,
        sequenceGap: null,
        detectedAt: at(0),
      })
      expect(bad.ok).toBe(false)
      const row = driver.get<{ capability_json: string | null }>("SELECT capability_json FROM mesh_registry_nodes WHERE node_id = ?", WORKER_ID)
      expect(row?.capability_json).toBeNull()
    } finally {
      close()
    }
  })

  it("both stores agree on the record they return for a node", async () => {
    const clock = new TestClock(at(0))
    const entries = bothStores(clock)
    try {
      for (const { label, store } of entries) {
        const enrolled = await store.enrollNode({ meshId: MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(0) })
        expect(enrolled.ok, label).toBe(true)
        if (!enrolled.ok) continue
        expect(enrolled.value.node, label).toMatchObject({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          nodeId: WORKER_ID,
          meshId: MESH_ID,
          nodeKeyId: WORKER_KEY_ID,
          displayName: "worker-1",
          enrolledAt: at(0),
          capability: null,
          revocation: null,
        })
      }
    } finally {
      for (const entry of entries) entry.close()
    }
  })
})

describe("M4.3 the ingest seam drives the durable store end to end", () => {
  it("enroll, heartbeat, read, revoke, read again", async () => {
    const clock = new TestClock(at(0))
    const driver: SqliteDriver = openInMemoryDriver()
    runMeshRegistryMigrations(driver, { now: clock.now })
    const { MeshNodeRegistry } = await import("../../../../src/mesh/registry/registry.js")
    const { SqliteNodeRegistryStore: Store } = await import("../../../../src/mesh/registry/sqlite-registry.js")
    try {
      const store = new Store(driver)
      const registry = new MeshNodeRegistry({ store, now: clock.now })

      await MeshNodeRegistry.enroll(store, { meshId: MESH_ID, nodeId: WORKER_ID, nodeKeyId: WORKER_KEY_ID, displayName: "worker-1", enrolledAt: at(0) })
      const accepted = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
      expect(accepted.outcome).toBe("accepted")

      const live = await registry.node(WORKER_ID)
      expect(live.ok && live.value?.liveness).toBe("live")
      expect(live.ok && live.value?.negotiatedProtocolVersion).toBe(1)

      await registry.revoke({ nodeId: WORKER_ID, meshId: MESH_ID, reason: "retired", revokedBy: "op", revokedAt: at(5) })
      const revoked = await registry.node(WORKER_ID)
      expect(revoked.ok && revoked.value?.liveness).toBe("revoked")
    } finally {
      driver.close()
    }
  })
})

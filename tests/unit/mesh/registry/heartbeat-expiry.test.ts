import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_HEARTBEAT_AGE_MS } from "../../../../src/mesh/protocol/bounds.js"
import {
  MESH_ID,
  OTHER_MESH_ID,
  STRANGER_ID,
  WORKER_ID,
  TestClock,
  at,
  durableRegistry,
  enroll,
  heartbeatEnvelope,
  inMemoryRegistry,
  iso,
} from "./fixtures.js"

const REGISTRY_SOURCE = join(import.meta.dirname, "../../../../src/mesh/registry")

/**
 * Clock-injected expiration.
 *
 * Every assertion here is a NUMBER. Nothing in this file waits, and the boundary is
 * probed on both sides of `MAX_HEARTBEAT_AGE_MS` rather than at a round number,
 * because a TTL that is only ever tested at "well past" and "well within" does not
 * test a TTL.
 *
 * Both stores are exercised against the same expectations: the in-memory one is the
 * specification the durable one has to match, and a liveness derivation that lives
 * in only one of them is a liveness derivation that will disagree in production.
 */
describe("M4.3 heartbeat expiration is decided by the injected clock", () => {
  it("a node that has never heartbeated is never-seen, not live and not stale", async () => {
    const clock = new TestClock(at(600))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const node = await registry.node(WORKER_ID)
    expect(node.ok).toBe(true)
    if (!node.ok) return
    expect(node.value?.liveness).toBe("never-seen")
    expect(node.value?.lastHeartbeatAt).toBeNull()
    expect(node.value?.ageMs).toBeNull()
    expect(node.value?.negotiatedProtocolVersion).toBeNull()
    // Silence is not a record: no matter how far the clock advances, a node that has
    // never spoken does not become stale. It was never live, and the difference is
    // what tells an operator "this node has not checked in since it enrolled" apart
    // from "this node went quiet", which are different incidents with different
    // remedies.
    clock.set(at(100_000))
    const later = await registry.node(WORKER_ID)
    expect(later.ok && later.value?.liveness).toBe("never-seen")
  })

  it("a heartbeat is live up to the bound and stale one millisecond past it", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const accepted = await registry.recordHeartbeat(heartbeatEnvelope({ observedAt: iso(at(0)) }))
    expect(accepted.outcome).toBe("accepted")
    if (accepted.outcome !== "accepted") return
    expect(accepted.liveness).toBe("live")

    clock.set(at(0) + MAX_HEARTBEAT_AGE_MS)
    const atBound = await registry.node(WORKER_ID)
    expect(atBound.ok && atBound.value?.liveness).toBe("live")
    expect(atBound.ok && atBound.value?.ageMs).toBe(MAX_HEARTBEAT_AGE_MS)

    clock.set(at(0) + MAX_HEARTBEAT_AGE_MS + 1)
    const pastBound = await registry.node(WORKER_ID)
    expect(pastBound.ok && pastBound.value?.liveness).toBe("stale")
    expect(pastBound.ok && pastBound.value?.ageMs).toBe(MAX_HEARTBEAT_AGE_MS + 1)
  })

  it("liveness is derived at READ time, so a long-quiet node recovers the moment it speaks", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))

    clock.set(at(600))
    const stale = await registry.node(WORKER_ID)
    expect(stale.ok && stale.value?.liveness).toBe("stale")

    clock.set(at(700))
    const recovered = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(700)) }))
    expect(recovered.outcome).toBe("accepted")
    if (recovered.outcome === "accepted") expect(recovered.liveness).toBe("live")

    // No sweeper ran anywhere in that transition. That is the reason liveness is not
    // a column: a stored liveness needs something to recompute it, and a recompute
    // that stops running — a crash, a suspended controller, a clock step — leaves
    // every node claiming to be live forever, which is the failure the TTL exists to
    // prevent.
    const rows = store.heartbeatGaps(WORKER_ID)
    expect(rows).toEqual([])
  })

  it("a stale heartbeat that arrives late is RECORDED as stale, not refused", async () => {
    const clock = new TestClock(at(500))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    expect(result.outcome).toBe("accepted")
    if (result.outcome !== "accepted") return
    // A node that stopped heartbeating and then sent one from before it stopped has
    // told us something true and unhelpful. Refusing it would keep the previous,
    // even staler advertisement on file and would hide the fact that the node
    // reached out at all; storing it as `stale` records the reach and declines to
    // honour it, which is what the TTL is for.
    expect(result.liveness).toBe("stale")
  })

  it("a heartbeat observed in the future is refused and nothing is written", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const future = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(60)) }))
    expect(future.outcome).toBe("refused")
    if (future.outcome !== "refused") return
    expect(future.error.code).toBe("protocol.heartbeat_from_the_future")

    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.liveness).toBe("never-seen")
    expect(node.ok && node.value?.node.capability).toBeNull()
  })

  it("a refusal for a future heartbeat leaves a visible gap, not a silent hole", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    // Sequence 2 claims a time the controller cannot corroborate and is refused.
    const future = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(600)) }))
    expect(future.outcome).toBe("refused")
    if (future.outcome !== "refused") return
    expect(future.error.code).toBe("protocol.heartbeat_from_the_future")
    clock.set(at(1))
    // Sequence 3 is the node's next honest heartbeat. It is a GAP, and the gap is
    // the operator's evidence that a refusal happened rather than a packet loss —
    // which is the whole reason the refused write does not advance the sequence.
    const third = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 3, observedAt: iso(at(1)) }))
    expect(third.outcome).toBe("gapped")
    if (third.outcome === "gapped") expect([third.from, third.to]).toEqual([2, 2])
  })

  it("revoked outranks live: a node that keeps heartbeating after revocation stays revoked", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    clock.set(at(20))
    const revoked = await registry.revoke({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      reason: "machine reported stolen",
      revokedBy: "operator-1",
      revokedAt: at(10),
    })
    expect(revoked.ok).toBe(true)

    // A revoked node that does not know it was revoked keeps sending. It has to be
    // refused, not absorbed, or the revocation is a flag a peer can undo by being
    // alive — which is precisely the check that cannot be after the fact, because
    // by then the node has been sent work.
    const afterRevocation = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(20)) }))
    expect(afterRevocation.outcome).toBe("refused")
    if (afterRevocation.outcome !== "refused") return
    expect(afterRevocation.error.code).toBe("registry.node_revoked")

    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.liveness).toBe("revoked")
  })

  it("a heartbeat from a node that never enrolled is refused, and creates no row", async () => {
    const clock = new TestClock(at(0))
    const { registry } = inMemoryRegistry(clock)

    const result = await registry.recordHeartbeat(heartbeatEnvelope({ nodeId: STRANGER_ID, sequence: 1 }))
    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") return
    expect(result.error.code).toBe("registry.node_not_enrolled")

    const nodes = await registry.nodes(MESH_ID)
    expect(nodes.ok && nodes.value).toEqual([])
  })

  it("a heartbeat for a mesh the node is not enrolled in is refused", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(
      heartbeatEnvelope({ meshId: OTHER_MESH_ID, sequence: 1 }),
    )
    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") return
    // Tailscale reachability is not a cross-mesh grant, and neither is a heartbeat.
    expect(result.error.code).toBe("registry.node_wrong_mesh")
  })

  it("the durable store derives liveness identically", async () => {
    const clock = new TestClock(at(0))
    const { registry, store, close } = durableRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    clock.set(at(0) + MAX_HEARTBEAT_AGE_MS + 1)
    const stale = await registry.node(WORKER_ID)
    expect(stale.ok && stale.value?.liveness).toBe("stale")

    await registry.revoke({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      reason: "retired",
      revokedBy: "operator-1",
      revokedAt: at(1),
    })
    const revoked = await registry.node(WORKER_ID)
    expect(revoked.ok && revoked.value?.liveness).toBe("revoked")
    close()
  })

  it("no module in the registry reads a clock or a random source directly", () => {
    // A source scan rather than a code review, because the property is "there is no
    // place to put one", and a grep is the only thing that keeps it true after
    // someone adds a convenience. `new Date(ms)` with an argument is a conversion,
    // not a read, and is allowed.
    const offenders: string[] = []
    for (const file of readdirSync(REGISTRY_SOURCE)) {
      if (!file.endsWith(".ts")) continue
      const source = readFileSync(join(REGISTRY_SOURCE, file), "utf8")
      for (const [index, line] of source.split("\n").entries()) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue
        if (/Date\.now\s*\(/.test(line)) offenders.push(`${file}:${index + 1} Date.now`)
        if (/Math\.random\s*\(/.test(line)) offenders.push(`${file}:${index + 1} Math.random`)
        if (/new Date\s*\(\s*\)/.test(line)) offenders.push(`${file}:${index + 1} new Date()`)
      }
    }
    expect(offenders).toEqual([])
  })
})

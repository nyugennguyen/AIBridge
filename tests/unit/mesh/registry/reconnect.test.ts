import { describe, expect, it } from "vitest"
import { sampleEnvelope } from "../../protocol/fixtures.js"
import { readHeartbeatGaps } from "../../../../src/mesh/registry/gaps.js"
import { MESH_ID, WORKER_ID, TestClock, aCapabilitySnapshot, at, durableRegistry, enroll, heartbeatEnvelope, inMemoryRegistry, iso } from "./fixtures.js"

/**
 * Reconnect, replay and reordering.
 *
 * The three outcomes that must not be confused with one another, because each one
 * tells the operator something different and the difference is the operator's whole
 * next step:
 *
 *   - **duplicate** — this exact heartbeat was already accounted for. Nothing to do.
 *   - **gap** — heartbeats N..M were never seen. The node's liveness across that
 *     window is genuinely unknown and the range has to be asked for.
 *   - **regressed** — the sequence went BACKWARDS. Either the node restarted (and
 *     needs reconciling) or the sequence was forged.
 *
 * The tempting implementation — clamp, and move on — reports all three as "accepted"
 * and destroys the only signal that the mesh lost packets or that something came
 * back claiming to be a node it is not.
 */
describe("M4.3 heartbeat sequencing survives retry, reordering and restart", () => {
  it("the first heartbeat is accepted as `first`", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    expect(result.outcome).toBe("accepted")
    if (result.outcome !== "accepted") return
    expect(result.sequenceStatus).toBe("first")
    expect(result.negotiatedProtocolVersion).toBe(1)
  })

  it("a replayed heartbeat changes nothing at all", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)), capabilities: ["fs.read"] }),
    )
    const afterFirst = await registry.node(WORKER_ID)
    expect(afterFirst.ok && afterFirst.value?.node.capability?.capabilities).toEqual(["fs.read"])

    // The same sequence, resent with a DIFFERENT advertisement. A resend is not an
    // update: at-least-once delivery means the peer cannot know whether the first
    // copy arrived, so the second copy carries whatever the node believed when it
    // was sent. Writing it would let a reordered pair reorder the controller's view
    // of the node — the retransmission would overwrite a fresher claim with an
    // older one that happens to arrive later.
    const replay = await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)), capabilities: ["fs.read", "fs.write", "net.egress"] }),
    )
    expect(replay.outcome).toBe("duplicate")
    if (replay.outcome !== "duplicate") return
    expect(replay.lastSequence).toBe(1)

    const afterReplay = await registry.node(WORKER_ID)
    expect(afterReplay.ok && afterReplay.value?.node.capability?.capabilities).toEqual(["fs.read"])
    expect(afterReplay.ok && afterReplay.value?.node.capability?.sequence).toBe(1)
  })

  it("a sequence gap is SURFACED, recorded, and the heartbeat is still stored", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))

    clock.set(at(3))
    const gapped = await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 4, observedAt: iso(at(3)), capabilities: ["fs.read"] }),
    )
    expect(gapped.outcome).toBe("gapped")
    if (gapped.outcome !== "gapped") return
    expect(gapped.from).toBe(2)
    expect(gapped.to).toBe(3)
    expect(gapped.error.code).toBe("mesh.heartbeat_sequence_gap")

    // The node is demonstrably talking. Refusing its advertisement because the
    // CONTROLLER's transport dropped two records would be refusing work for a reason
    // that is not the node's fault and not the node's fix — and it would push a live
    // node back to `stale`, hiding sessions that are actually running.
    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.liveness).toBe("live")
    expect(node.ok && node.value?.node.capability?.capabilities).toEqual(["fs.read"])

    // The range is durable, because reconciliation has to be able to ask for it. A
    // gap that is only ever returned in a response is a gap that is lost the moment
    // the HTTP request ends.
    expect(store.heartbeatGaps(WORKER_ID)).toEqual([{ from: 2, to: 3 }])
  })

  it("in-order heartbeats after a gap are accepted, and the gap is not re-reported", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    clock.set(at(3))
    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 4, observedAt: iso(at(3)) }))
    clock.set(at(4))
    const next = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 5, observedAt: iso(at(4)) }))

    expect(next.outcome).toBe("accepted")
    if (next.outcome !== "accepted") return
    expect(next.sequenceStatus).toBe("in-order")
    expect(store.heartbeatGaps(WORKER_ID)).toEqual([{ from: 2, to: 3 }])
  })

  it("a lower sequence is refused and nothing is written", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 5, observedAt: iso(at(0)), capabilities: ["fs.read"] }),
    )

    clock.set(at(1))
    const regressed = await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 2, observedAt: iso(at(1)), capabilities: ["fs.read", "net.egress"] }),
    )
    expect(regressed.outcome).toBe("regressed")
    if (regressed.outcome !== "regressed") return
    expect(regressed.lastSequence).toBe(5)
    expect(regressed.error.code).toBe("mesh.heartbeat_sequence_regressed")

    // A resurrected node must not be able to overwrite fresher liveness with stale
    // liveness. Accepting the regression would let an attacker who knows a node id
    // re-assert an old advertisement with a lower sequence and have it believed.
    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.node.capability?.sequence).toBe(5)
    expect(node.ok && node.value?.node.capability?.capabilities).toEqual(["fs.read"])
  })

  it("a RESTART (sequence reset to 1) is reported as regressed, not as a gap", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 7, observedAt: iso(at(0)) }))
    clock.set(at(1))
    const afterRestart = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(1)) }))

    // A gap says "the transport lost records". A regression says "the node's state
    // was rolled back or forged". The operator's response is completely different —
    // reconcile the node versus investigate it — so the two must never share an
    // outcome, and neither may be reported as an ordinary acceptance.
    expect(afterRestart.outcome).toBe("regressed")
    expect(store.heartbeatGaps(WORKER_ID)).toEqual([])
  })

  it("a node with no common protocol version is recorded as incompatible, never downgraded", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)), protocolVersions: [7, 9] }),
    )
    expect(result.outcome).toBe("incompatible")
    if (result.outcome !== "incompatible") return
    expect(result.error.code).toBe("protocol.no_common_version")

    // Recorded rather than dropped, with a null negotiated version. Dropping it
    // would make an operator's only symptom be "the node is quiet", when the node is
    // loudly heartbeating a dialect this build cannot speak. The null is a stored
    // state, and `canScheduleOn` refuses it.
    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.negotiatedProtocolVersion).toBeNull()
    expect(node.ok && node.value?.node.capability?.offeredProtocolVersions).toEqual([7, 9])
    expect(node.ok && node.value?.liveness).toBe("live")
  })

  it("an envelope written at a dialect this build does not speak is refused as incompatible", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    // The payload claims a version we speak, but the ENVELOPE it arrived in was
    // written at a version we do not. There is no consistent reading of a record
    // whose declared dialect and claimed dialect disagree, and "proceed on the parts
    // I happen to understand" is the exact failure the version table exists to stop.
    const result = await registry.recordHeartbeat(
      heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)), envelopeProtocolVersion: 3 }),
    )
    expect(result.outcome).toBe("incompatible")
    if (result.outcome !== "incompatible") return
    expect(result.error.code).toBe("protocol.envelope_version_unsupported")
  })

  it("a heartbeat at an unknown schema version is refused before anything is read", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, schemaVersion: 9 }))
    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") return
    // Never coerced, never defaulted, never partially read: a node must not guess at
    // a shape it does not understand, and the version is read BEFORE the shape.
    expect(result.error.code).toBe("protocol.unsupported_schema_version")

    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.liveness).toBe("never-seen")
  })

  it("a non-heartbeat record offered to the ingest seam is refused", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    const result = await registry.recordHeartbeat(
      sampleEnvelope("mesh.lease"),
    )
    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") return
    // A structurally VALID lease. The registry parses first and asks second, and
    // that order is right: a record this build cannot read has no business being
    // reported as the wrong kind of record, and the distinction tells an operator
    // whether to fix the sender or to fix their own wiring.
    expect(result.error.code).toBe("registry.not_a_heartbeat")
  })

  it("the durable store agrees on every outcome and persists the gap", async () => {
    const clock = new TestClock(at(0))
    const { registry, store, driver } = durableRegistry(clock)
    await enroll(store, {})

    expect((await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))).outcome).toBe("accepted")
    expect((await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))).outcome).toBe("duplicate")
    clock.set(at(2))
    const gap = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 3, observedAt: iso(at(2)) }))
    expect(gap.outcome).toBe("gapped")
    clock.set(at(3))
    const back = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(3)) }))
    expect(back.outcome).toBe("regressed")

    expect(store.heartbeatGaps(WORKER_ID)).toEqual([{ from: 2, to: 2 }])
    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.node.capability?.sequence).toBe(3)
    driver.close()
  })

  it("two heartbeats racing on one node: the loser is told to retry, and the row holds one winner", async () => {
    const clock = new TestClock(at(0))
    const { store } = inMemoryRegistry(clock)
    await enroll(store, {})

    // Both writers read sequence 1 and both decide that 2 is in-order. The
    // compare-and-set is what stops both writes; a check and a write that are two
    // operations have a gap between them and this is what lives in the gap.
    const snapshot = aCapabilitySnapshot({ observedAt: iso(at(1)), sequence: 2 })
    const first = await store.writeHeartbeat({
      nodeId: WORKER_ID,
      expectedSequence: null,
      snapshot: { ...snapshot, sequence: 1 },
      sequenceGap: null,
      detectedAt: at(0),
    })
    expect(first.ok && first.value.written).toBe(true)

    const [a, b] = await Promise.all([
      store.writeHeartbeat({ nodeId: WORKER_ID, expectedSequence: 1, snapshot, sequenceGap: null, detectedAt: at(1) }),
      store.writeHeartbeat({ nodeId: WORKER_ID, expectedSequence: 1, snapshot, sequenceGap: null, detectedAt: at(1) }),
    ])
    expect(a.ok && a.value.written).toBe(true)
    expect(b.ok && b.value.written).toBe(false)
    expect(store.lastSequence(WORKER_ID)).toBe(2)
  })

  it("recorded gaps are readable through the seam a consumer actually calls", async () => {
    const clock = new TestClock(at(0))
    const { registry, store, driver, close } = durableRegistry(clock)
    await enroll(store, {})

    for (const sequence of [1, 4, 5, 8]) {
      clock.set(at(sequence))
      await registry.recordHeartbeat(heartbeatEnvelope({ sequence, observedAt: iso(at(sequence)) }))
    }

    // Sorted and de-duplicated by the seam rather than trusted from the store: two
    // stores keeping the same order is one more thing to keep in step, and an
    // out-of-order gap list is exactly what makes a reconciliation resend look like
    // it is going backwards.
    const gaps = readHeartbeatGaps(store, WORKER_ID)
    expect(gaps.ok && gaps.value).toEqual([{ from: 2, to: 3 }, { from: 6, to: 7 }])
    close()
    driver.close()
  })

  it("a gap reader that throws is a refusal, not an empty list", () => {
    // "There are no gaps" and "we could not look" have to be different values, or a
    // storage fault becomes a clean reconciliation report — which is the exact
    // conclusion step 6 of the plan's reconciliation exists to avoid reaching
    // without evidence.
    const broken = {
      heartbeatGaps(): never {
        throw new Error("disk is gone")
      },
    }
    const gaps = readHeartbeatGaps(broken, WORKER_ID)
    expect(gaps.ok).toBe(false)
    if (gaps.ok) return
    expect(gaps.error.code).toBe("registry.gaps_unreadable")
  })

  it("a revocation mid-reconnect stops the ingest and the node stays revoked", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    clock.set(at(2))
    await registry.revoke({ nodeId: WORKER_ID, meshId: MESH_ID, reason: "stolen", revokedBy: "op", revokedAt: at(1) })

    // The reconnect. It is refused, and the stored sequence is untouched — so an
    // operator reconciling the node afterwards still sees the last advertisement
    // that was accepted BEFORE the revocation rather than one written by the revoked
    // node afterwards.
    const reconnect = await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(2)) }))
    expect(reconnect.outcome).toBe("refused")
    const node = await registry.node(WORKER_ID)
    expect(node.ok && node.value?.liveness).toBe("revoked")
    expect(node.ok && node.value?.node.capability?.sequence).toBe(1)
  })
})

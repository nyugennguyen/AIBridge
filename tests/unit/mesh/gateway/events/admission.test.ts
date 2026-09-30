/**
 * M4.6 — admission: duplicates, out-of-order arrivals, gaps, and version refusal.
 *
 * Each is a DIFFERENT defect, and collapsing any two of them is the mistake this
 * file exists to prevent:
 *
 *   - A duplicate is the EXPECTED shape of at-least-once delivery. It is a
 *     suppression, not an error, and an operator who sees errors for every
 *     retransmission learns to ignore this result.
 *   - An out-of-order arrival is a per-source sequence behind the watermark. Also a
 *     suppression: re-applying it would put the stream backwards.
 *   - A GAP is neither. A position this node never emitted is a real hole, and it
 *     is refused rather than skipped — a missing `dispatch.started` is precisely
 *     what makes a running session read as un-run, and the remedy an operator
 *     reaches for (retry) is the duplicate this mesh exists to prevent.
 *   - A version refusal is a fourth thing again, and the flag that separates
 *     "upgrade the peer" from "your sender is broken" is what stops a version-skewed
 *     node retrying forever.
 *
 * Nothing sleeps. The clock is injected.
 */
import { describe, expect, it } from "vitest"
import { MeshEventGateway } from "../../../../../src/mesh/gateway/events/index.js"
import { CURRENT_SCHEMA_VERSION } from "../../../../../src/orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../../src/mesh/protocol/negotiation.js"
import { OTHER_WORKER, WORKER, TestClock, aMeshEvent, eventEnvelope } from "../fixtures.js"

async function publish(gateway: MeshEventGateway, event: Parameters<typeof aMeshEvent>[0], envelopeOverrides: Record<string, unknown> = {}) {
  return await gateway.publish(eventEnvelope(aMeshEvent(event), envelopeOverrides))
}

describe("a redelivery converges onto the entry already held", () => {
  it("suppresses the same eventId as a duplicate, and does not consume a position", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const event = aMeshEvent({ eventId: "evt-dup-1", localSequence: 1 })

    const first = await gateway.publish(eventEnvelope(event))
    expect(first.ok && first.outcome.accepted).toBe(true)
    if (!first.ok || !first.outcome.accepted) return
    const position = first.outcome.entry.position

    const second = await gateway.publish(eventEnvelope(event))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // A suppression, not an error, and the reason is in the disposition rather than
    // implied: at-least-once delivery means a retransmission is the normal case.
    expect(second.outcome.accepted).toBe(false)
    if (second.outcome.accepted) return
    expect(second.outcome.disposition).toBe("duplicate")
    expect("error" in second.outcome).toBe(false)
    expect(gateway.head()).toBe(position)
    expect(gateway.retained()).toHaveLength(1)
  })

  it("checks the eventId BEFORE the sequence, or a redelivery reads as out-of-order", async () => {
    // The order is load-bearing and matches `MeshEventIngestor.ingest`'s. Once the
    // watermark has moved past an event, evaluating that event through the SEQUENCE
    // check classifies it as out-of-order — which is exactly what happens after the
    // very redelivery the plan requires to be harmless, and an operator then reads a
    // retransmission as a defect.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-order-1", localSequence: 1 })
    await publish(gateway, { eventId: "evt-order-2", localSequence: 2 })
    await publish(gateway, { eventId: "evt-order-3", localSequence: 3 })

    const redelivered = await publish(gateway, { eventId: "evt-order-1", localSequence: 1 })
    expect(redelivered.ok).toBe(true)
    if (!redelivered.ok || redelivered.outcome.accepted) return
    expect(redelivered.outcome.disposition).toBe("duplicate")
  })

  it("a redelivery from a DIFFERENT run's sender is still a duplicate on the id", async () => {
    // `eventId` is globally unique in the protocol, so an id that is already on the
    // stream is the same event wherever it claims to be from. Dedupe on the id and not
    // on `(sourceNodeId, eventId)` is what makes a retry across a worker restart
    // converge, because a restarted node keeps its ids and its sequence resets.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-shared-id", localSequence: 1, nodeId: WORKER })
    const elsewhere = await publish(gateway, { eventId: "evt-shared-id", localSequence: 1, nodeId: OTHER_WORKER })
    expect(elsewhere.ok).toBe(true)
    if (!elsewhere.ok || elsewhere.outcome.accepted) return
    expect(elsewhere.outcome.disposition).toBe("duplicate")
  })
})

describe("an out-of-order arrival is suppressed, not applied", () => {
  it("suppresses a lower localSequence from a source whose watermark has moved", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-ooo-1", localSequence: 1 })
    await publish(gateway, { eventId: "evt-ooo-2", localSequence: 2 })

    // A NEW event id at an old sequence. Not a duplicate — nothing has seen this id —
    // and not a gap either, because nothing is missing.
    const late = await publish(gateway, { eventId: "evt-ooo-late", localSequence: 1 })
    expect(late.ok).toBe(true)
    if (!late.ok || late.outcome.accepted) return
    expect(late.outcome.disposition).toBe("out_of_order")
    expect(late.outcome.detail).toContain("highest sequence accepted (2)")
    // The stream did not move backwards.
    expect(gateway.retained()).toHaveLength(2)
    expect(gateway.head()).toBe(2)
  })

  it("does NOT let a late arrival lower the watermark", async () => {
    // The tracker records the HIGHEST sequence ever accepted, not the last. A
    // watermark that moved backwards would make a permanently-lost sequence look
    // still-expected, and the gap check would stop catching real holes.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-wm-1", localSequence: 1 })
    await publish(gateway, { eventId: "evt-wm-2", localSequence: 2 })
    await publish(gateway, { eventId: "evt-wm-3", localSequence: 3 })
    await publish(gateway, { eventId: "evt-wm-late", localSequence: 2 })

    // 4 is still in order after the late arrival, so the watermark did not drop to 2.
    const fourth = await publish(gateway, { eventId: "evt-wm-4", localSequence: 4 })
    expect(fourth.ok && fourth.outcome.accepted).toBe(true)
  })

  it("watermarks are PER SOURCE NODE, so one node's sequence says nothing about another's", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    // Worker A is at 5. Worker B's 1 is its FIRST event, not a late arrival, and
    // treating it as out-of-order would refuse every event from every node that
    // happens to be early in its own run.
    await publish(gateway, { eventId: "evt-per-a5", localSequence: 5, nodeId: WORKER })
    const fromB = await publish(gateway, { eventId: "evt-per-b1", localSequence: 1, nodeId: OTHER_WORKER })
    expect(fromB.ok && fromB.outcome.accepted).toBe(true)
  })
})

describe("a gap is refused, and the missing range is named", () => {
  it("refuses a jump and does NOT advance the watermark", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-gap-1", localSequence: 1 })

    const jumped = await publish(gateway, { eventId: "evt-gap-4", localSequence: 4 })
    expect(jumped.ok).toBe(true)
    if (!jumped.ok || jumped.outcome.accepted) return
    expect(jumped.outcome.disposition).toBe("gap")
    // A gap CARRIES an error, unlike a duplicate or a late arrival: this one is a real
    // hole, and the error is what tells the operator to ask for 2-3 rather than to
    // carry on.
    expect("error" in jumped.outcome && jumped.outcome.error.code).toBe("mesh.event_sequence_gap")
    expect(jumped.outcome.detail).toContain("2-3")
    expect(gateway.retained()).toHaveLength(1)
  })

  it("the event that fills the hole is then accepted, so the gap closes with no operator action", async () => {
    // The payoff of NOT advancing across a hole: the missing position still fits, and
    // a reconciliation pass rather than a human retry is what closes it.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publish(gateway, { eventId: "evt-close-1", localSequence: 1 })
    const jumped = await publish(gateway, { eventId: "evt-close-4", localSequence: 4 })
    expect(jumped.ok && !jumped.outcome.accepted).toBe(true)

    const filler = await publish(gateway, { eventId: "evt-close-2", localSequence: 2 })
    expect(filler.ok && filler.outcome.accepted).toBe(true)
  })

  it("a node this gateway has never heard of must START at 1", async () => {
    // The property that stops "accept the first thing you see": a first arrival at 7
    // would make 1-6 permanently unrecoverable while looking like a clean start, and
    // the projection would be built across a hole nobody can see.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const jumped = await publish(gateway, { eventId: "evt-first-7", localSequence: 7, nodeId: OTHER_WORKER })
    expect(jumped.ok).toBe(true)
    if (!jumped.ok || jumped.outcome.accepted) return
    expect(jumped.outcome.disposition).toBe("gap")
    expect(jumped.outcome.detail).toContain("1-6")
  })
})

describe("a record at the wrong version is refused, and the two reasons stay apart", () => {
  it("refuses an UNSUPPORTED version as 'upgrade the peer', flagged versionError", async () => {
    // `versionError: true` is the operational field. It means the record will never
    // parse on this build however long it is retried, so the remedy is to change a
    // node — not to retry, and not to go looking for a sender bug.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const result = await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-v99", localSequence: 1 }), { schemaVersion: 99 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("version_unsupported")
    expect(result.versionError).toBe(true)
    expect(result.error.code).toBe("protocol.unsupported_schema_version")
    expect(gateway.retained()).toHaveLength(0)
  })

  it("refuses an UNVERSIONED record as a version problem too, since it can never parse", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const envelope = eventEnvelope(aMeshEvent({ eventId: "evt-unversioned", localSequence: 1 }))
    delete (envelope as Record<string, unknown>).schemaVersion
    const result = await gateway.publish(envelope)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("version_unsupported")
    expect(result.versionError).toBe(true)
    expect(result.error.code).toBe("protocol.unversioned_record")
  })

  it("refuses a MALFORMED record at a supported version as 'your sender is broken'", async () => {
    // `versionError: false`, and the difference is the whole point: this will never
    // get better by upgrading anything, because both sides already speak this
    // version. Answering it as version skew sends an operator to reinstall a node
    // whose actual problem is a sender bug.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const envelope = eventEnvelope(aMeshEvent({ eventId: "evt-malformed", localSequence: 1 }))
    // A version this build DOES understand, with a payload that violates it.
    ;(envelope.payload as Record<string, unknown>).localSequence = "not a number"
    const result = await gateway.publish(envelope)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("record_invalid")
    expect(result.versionError).toBe(false)
  })

  it("refuses a record whose family is not an EVENT, and says which family it is", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const result = await gateway.publish({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      recordType: "mesh.heartbeat",
      messageId: "msg-1",
      correlationId: "hb-1",
      causation: null,
      senderNodeId: WORKER,
      // A heartbeat is addressed to the node it reports on, so the recipient has to
      // be the worker itself. Getting this wrong would make the record invalid for a
      // reason that has nothing to do with the family check under test.
      recipientNodeId: WORKER,
      protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      issuedAt: "2026-09-28T00:00:00.000Z",
      expiresAt: "2026-09-28T01:00:00.000Z",
      payload: {
        meshId: "mesh-release",
        nodeId: WORKER,
        observedAt: "2026-09-28T00:00:00.000Z",
        sequence: 1,
        liveness: "live",
        runtimeKinds: ["opencode"],
        capabilities: ["fs.read"],
        projectPathIds: ["path-release-1"],
        maxConcurrentSessions: 1,
        protocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
        agentCount: 1,
        load: { activeSessions: 0, queuedSessions: 0 },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe("not_an_event")
    // The message names the family, because "this seam streams events" is not an
    // answer to "which record did you send".
    expect(result.error.message).toContain("mesh.heartbeat")
    // And it says WHY the seam refuses another family: another family has no
    // `localSequence` to order it by, so interpreting it here would put a record on
    // the stream with no position.
    expect(result.error.message).toContain("localSequence")
  })

  it("refuses an unknown record family rather than parsing it as a generic object", async () => {
    // M4-V, restated at this seam: a node must never guess at a shape it does not
    // understand, and a record from the future is exactly the thing that gets
    // partially read by a build that does not.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const result = await gateway.publish({ schemaVersion: 2, recordType: "mesh.future.thing", payload: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("protocol.unknown_record_type")
    expect(result.versionError).toBe(false)
  })

  it("accepts the version the family declares, so a version refusal is ABOUT the version", async () => {
    // The negative tests above only mean something because the positive case works,
    // so a reader can tell a version refusal from a schema refusal. `mesh.event`
    // declares exactly one version, so this is also the assertion that a family
    // which has never had to answer "which version is this" refuses the others
    // rather than re-interpreting a record with a shape it does not have.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const result = await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-current", localSequence: 1 })))
    expect(result.ok).toBe(true)
    expect(gateway.retained()).toHaveLength(1)

    // Version 1 is inside `SCHEMA_VERSIONS` and the family still does not declare it,
    // which is `protocol.unsupported_schema_version` and NOT a record_invalid: the
    // shape for that version was never written, so no amount of fixing the sender
    // would produce one.
    const older = await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-v1", localSequence: 2 }), { schemaVersion: 1 }))
    expect(older.ok).toBe(false)
    if (older.ok) return
    expect(older.versionError).toBe(true)
    expect(older.error.code).toBe("protocol.unsupported_schema_version")
  })
})

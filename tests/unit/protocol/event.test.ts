import { describe, expect, it } from "vitest"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../src/mesh/protocol/negotiation.js"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import {
  EventSequenceTracker,
  checkLocalSequence,
  mintMeshEvent,
  nextLocalSequence,
  type LocalSequenceVerdict,
} from "../../../src/mesh/protocol/event.js"
import {
  CONTROLLER_ID,
  T1,
  makeEvent,
  makeOversizedEvent,
  rawEnvelope,
  sampleEnvelope,
  WORKER_ID,
} from "./fixtures.js"

/**
 * §4.6 of the spec, and scenarios 1 and 3 of the diagrams.
 *
 * Two identities have to survive a restart for the outbox to converge: `eventId`,
 * so the controller's ingestion dedupes, and `localSequence`, so the controller
 * can tell "resent" from "skipped". A restart that re-emitted an event under a
 * NEW id would look like a second event that happened, which is how a retried
 * effect becomes a duplicated one four steps later — and the "one session per
 * dispatch" completion criterion fails at a point nothing in the log points at.
 *
 * The third thing asserted here is the GAP. `localSequence` exists to make a hole
 * visible; the tests below pin the fact that a hole is reported rather than
 * skipped, and that the FIRST event from a node must be 1 rather than "whatever
 * arrived first", which would make sequences 1..n permanently unrecoverable
 * behind a record that looks like a clean start.
 */

describe("minting a mesh.event", () => {
  it("stamps the mesh protocol version, the sequence and the run/project scope from the event", () => {
    const record = mintMeshEvent({ event: makeEvent(), sourceNodeId: WORKER_ID, localSequence: 7 })
    expect(record.meshProtocolVersion).toBe(CURRENT_MESH_PROTOCOL_VERSION)
    expect(record.localSequence).toBe(7)
    expect(record.eventId).toBe("evt-1")
    expect(record.observedAt).toBe(T1)
    expect(record.runProjectScope).toEqual({ projectId: "project-release", runId: "run-release-1" })
    expect(record.eventType).toBe(record.event.type)
  })

  it("derives the command correlation from the event, and lets the caller state it explicitly", () => {
    // Mirroring by default is what keeps the mesh correlation and the kernel
    // `commandId` from disagreeing: the schema refuses a record where they do,
    // so a caller that wanted them to differ would have to say so on purpose.
    const answering = makeEvent({ eventId: "evt-2", commandId: "cmd-7" })
    expect(mintMeshEvent({ event: answering, sourceNodeId: WORKER_ID, localSequence: 1 }).commandCorrelation).toBe("cmd-7")

    const spontaneous = makeEvent({ eventId: "evt-3" })
    expect(mintMeshEvent({ event: spontaneous, sourceNodeId: WORKER_ID, localSequence: 1 }).commandCorrelation).toBeNull()
  })

  it("refuses a localSequence of zero, because the sequence is one-based", () => {
    // A zero-based sequence cannot be distinguished from "nothing yet" by a
    // receiver tracking "the last one I accepted", which is what makes a gap
    // reportable at all.
    expect(() => mintMeshEvent({ event: makeEvent(), sourceNodeId: WORKER_ID, localSequence: 0 })).toThrow()
  })
})

describe("mesh.event envelope closure", () => {
  it("parses a well-formed event and preserves its identity through the registry", () => {
    const safe = safeParseMeshEnvelope(sampleEnvelope("mesh.event"))
    expect(safe.ok).toBe(true)
    if (!safe.ok) return
    expect(safe.value.schemaVersion).toBe(2)
    expect(safe.value.correlationId).toBe("evt-1")
    expect(safe.value.protocolVersion).toBe(CURRENT_MESH_PROTOCOL_VERSION)
    // Narrowed on `recordType`, which is the point of the union: a gateway that
    // reads `payload` without switching on the record type is reading a cast.
    expect(safe.value.recordType).toBe("mesh.event")
    if (safe.value.recordType !== "mesh.event") return
    expect(safe.value.payload.localSequence).toBe(1)
  })

  it("refuses a correlation that names a command rather than the event itself", () => {
    // The command is the CAUSATION. Conflating the two leaves a controller unable
    // to answer "which events came back for command X" without walking the log.
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.event", { correlationId: "cmd-7" })).ok).toBe(false)
  })

  it("refuses an event whose wire scope disagrees with its payload's scope", () => {
    const payload = sampleEnvelope("mesh.event").payload as Record<string, unknown>
    for (const override of [
      { runProjectScope: { projectId: "project-other", runId: "run-release-1" } },
      { runProjectScope: { projectId: "project-release", runId: "run-other" } },
      { eventId: "evt-9" },
      { eventType: "run.paused" },
    ]) {
      expect(
        safeParseMeshEnvelope({ ...sampleEnvelope("mesh.event"), payload: { ...payload, ...override } }).ok,
        JSON.stringify(override),
      ).toBe(false)
    }
  })

  it("refuses a command correlation that the event's own commandId contradicts, in both directions", () => {
    const answering = makeEvent({ eventId: "evt-4", commandId: "cmd-7" })
    const record = mintMeshEvent({ event: answering, sourceNodeId: WORKER_ID, localSequence: 1 })
    const envelope = (id: string | null) =>
      rawEnvelope("mesh.event", { ...record, commandCorrelation: id }, {
        correlationId: "evt-4",
        senderNodeId: WORKER_ID,
        recipientNodeId: CONTROLLER_ID,
      })
    expect(safeParseMeshEnvelope(envelope("cmd-7")).ok).toBe(true)
    // A correlation naming a command the event does not answer is one the
    // controller would use to attribute work to a command that never ran.
    expect(safeParseMeshEnvelope(envelope("cmd-8")).ok).toBe(false)
    expect(safeParseMeshEnvelope(envelope(null)).ok).toBe(false)
  })

  it("refuses a third-party report", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.event", { senderNodeId: "node-worker-2" })).ok).toBe(false)
  })

  it("carries a stable id across a resend, which is what makes ingestion dedupe converge", () => {
    // Scenario 3: the same event, replayed, is the same id. If minting a retry
    // produced a new id the controller would ingest a second event and the
    // duplicate-work defect would appear four steps downstream, nowhere near
    // its cause.
    const event = makeEvent({ eventId: "evt-stable", sequence: 4 })
    const first = mintMeshEvent({ event, sourceNodeId: WORKER_ID, localSequence: 4 })
    const resent = mintMeshEvent({ event, sourceNodeId: WORKER_ID, localSequence: 4 })
    expect(resent.eventId).toBe(first.eventId)
    expect(resent.localSequence).toBe(first.localSequence)
    const replayed = rawEnvelope("mesh.event", resent, {
      correlationId: "evt-stable",
      senderNodeId: WORKER_ID,
      recipientNodeId: CONTROLLER_ID,
    })
    const safe = safeParseMeshEnvelope(replayed)
    expect(safe.ok).toBe(true)
    if (!safe.ok || safe.value.recordType !== "mesh.event") return
    expect(safe.value.payload.eventId).toBe("evt-stable")
  })

  it("applies the event payload bound on the receiving side as well as on minting", () => {
    // Minting is not the only door: a peer builds its own bytes. The record is
    // therefore assembled as a literal rather than through `mintMeshEvent`,
    // which is precisely the path this assertion is about.
    const oversized = makeOversizedEvent(64, 4_090)
    const safe = safeParseMeshEnvelope(
      rawEnvelope(
        "mesh.event",
        {
          meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
          eventId: oversized.eventId,
          sourceNodeId: WORKER_ID,
          commandCorrelation: null,
          localSequence: 1,
          observedAt: oversized.occurredAt,
          runProjectScope: { projectId: oversized.projectId, runId: oversized.runId },
          eventType: oversized.type,
          event: oversized,
        },
        { correlationId: oversized.eventId, senderNodeId: WORKER_ID, recipientNodeId: CONTROLLER_ID },
      ),
    )
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain("131072 byte bound")
    // And the producing side refuses it, so such a record never reaches an outbox.
    expect(() => mintMeshEvent({ event: oversized, sourceNodeId: WORKER_ID, localSequence: 1 })).toThrow(/131072 byte bound/)
  })
})

describe("nextLocalSequence", () => {
  it("accepts the first event from a node only when it is sequence 1", () => {
    // "Whatever arrived first" would make sequences 1..6 permanently
    // unrecoverable while looking exactly like a clean start.
    expect(nextLocalSequence(null, 1)).toEqual({ status: "in-order", accepted: true, expected: 1, nextExpected: 2 })
    const jumped = nextLocalSequence(null, 7)
    expect(jumped.status).toBe("gap")
    expect(jumped.status === "gap" && jumped.missingFrom).toBe(1)
    expect(jumped.status === "gap" && jumped.missingTo).toBe(6)
    expect(jumped.status === "gap" && jumped.missingCount).toBe(6)
  })

  it("reports a duplicate as an expected outcome rather than as an error", () => {
    // At-least-once delivery makes a resend routine; a controller that treated
    // one as a failure would drop legitimate redeliveries and stall the outbox.
    const duplicate = nextLocalSequence(5, 5)
    expect(duplicate).toEqual({ status: "duplicate", accepted: false, reason: expect.stringContaining("5"), highestAccepted: 5 })
    const older = nextLocalSequence(5, 3)
    expect(older.status).toBe("duplicate")
    expect(older.status === "duplicate" && older.reason).toContain("3")
    // A resend is not an error and carries no ContractError; only a GAP does,
    // because a gap is the one the controller has to act on.
    expect(duplicate.status === "duplicate" && "error" in duplicate).toBe(false)
  })

  it("reports a gap with the exact range to ask for, and never accepts across it", () => {
    const gap = nextLocalSequence(3, 6)
    expect(gap).toMatchObject({ status: "gap", accepted: false, missingFrom: 4, missingTo: 5, missingCount: 2 })
    expect(gap.status === "gap" && gap.error.code).toBe("mesh.event_sequence_gap")
    expect(gap.status === "gap" && gap.error.retryable).toBe(false)
    expect(gap.status === "gap" && gap.error.message).toContain("4-5")
  })

  it("flavours the refusals through the Result seam", () => {
    expect(checkLocalSequence(2, 3)).toEqual({ ok: true, value: true })
    const gapped = checkLocalSequence(2, 9)
    expect(gapped.ok).toBe(false)
    expect(gapped.ok === false && gapped.error.code).toBe("mesh.event_sequence_gap")
    const repeated = checkLocalSequence(9, 4)
    expect(repeated.ok === false && repeated.error.code).toBe("mesh.event_sequence_duplicate")
  })
})

describe("EventSequenceTracker", () => {
  it("never moves its watermark backwards on a duplicate or a gap", () => {
    // The watermark is the HIGHEST sequence ever accepted. Lowering it on a
    // late arrival would make a permanently-lost sequence look still-expected,
    // which is the opposite of what the tracker is for.
    const tracker = new EventSequenceTracker(WORKER_ID)
    expect(tracker.highestAccepted).toBeNull()
    expect(tracker.evaluate(1).accepted).toBe(true)
    expect(tracker.evaluate(2).accepted).toBe(true)
    expect(tracker.evaluate(2).status).toBe("duplicate")
    expect(tracker.evaluate(9).status).toBe("gap")
    expect(tracker.highestAccepted).toBe(2)
    expect(tracker.toString()).toContain("node-worker-1@2")
  })

  it("names the range a gap says to request", () => {
    const tracker = new EventSequenceTracker(WORKER_ID)
    tracker.evaluate(1)
    const verdict: LocalSequenceVerdict = tracker.evaluate(4)
    expect(EventSequenceTracker.missingRange(verdict)).toEqual({ from: 2, to: 3 })
    expect(EventSequenceTracker.missingRange(tracker.evaluate(2))).toBeNull()
  })

  it("re-baselines explicitly on a restart rather than doing it silently", () => {
    // A restarted worker resets its sequence, and those events arrive carrying
    // 1 again. Re-baselining on an automatic "I restarted" would let a node that
    // did NOT restart look regressed, so it is a separate act.
    const tracker = new EventSequenceTracker(WORKER_ID)
    tracker.evaluate(1)
    tracker.evaluate(2)
    tracker.evaluate(3)
    expect(tracker.evaluate(1).status).toBe("duplicate")
    tracker.rebaseAfterRestart()
    expect(tracker.highestAccepted).toBeNull()
    expect(tracker.evaluate(1).status).toBe("in-order")
  })

  it("converges on a resend storm: five copies of one sequence, one acceptance", () => {
    const tracker = new EventSequenceTracker(WORKER_ID)
    for (const sequence of [1, 2, 3]) tracker.evaluate(sequence)
    const outcomes = Array.from({ length: 5 }, () => tracker.evaluate(4))
    expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "duplicate")).toHaveLength(4)
    expect(tracker.highestAccepted).toBe(4)
  })
})

describe("event types carried on the wire", () => {
  it("refuses a declared eventType the kernel has no event for", () => {
    const payload = sampleEnvelope("mesh.event").payload as Record<string, unknown>
    const safe = safeParseMeshEnvelope({ ...sampleEnvelope("mesh.event"), payload: { ...payload, eventType: "session.exploded" } })
    expect(safe.ok).toBe(false)
  })

  it("binds the declared eventType to the payload's own type in both directions", () => {
    // A mesh record that names one type and carries another would let a
    // controller route on the wire field and rebuild from the payload, and the
    // two routes would disagree about what happened.
    const payload = sampleEnvelope("mesh.event").payload as Record<string, unknown>
    for (const eventType of ["session.exploded", "dispatch.proposed", "run.created"]) {
      const safe = safeParseMeshEnvelope({ ...sampleEnvelope("mesh.event"), payload: { ...payload, eventType } })
      expect(safe.ok, eventType).toBe(false)
    }
    expect(mintMeshEvent({ event: makeEvent(), sourceNodeId: WORKER_ID, localSequence: 1 }).eventType).toBe("session.observed")
  })
})

/**
 * M4.9's acceptance scenario, end to end, through a faulted wire.
 *
 * The plan's line is "Acceptance scenario succeeds without duplicate work", and
 * this is that scenario: two nodes enrol, advertise what they can do, run a
 * dispatch, report on it, and a client streams the reports and resumes after a
 * disconnect — all while the transport delays, drops, duplicates and cuts
 * records. Nothing here reads a wall clock; every instant is the scripted one.
 *
 * The duplicate-work assertions are stated as EXACT counts rather than as
 * "at least one", because a scenario that asserts a lower bound cannot fail:
 *
 *   - `runtime().sessions` has exactly one entry, and it is the session the
 *     dispatch named;
 *   - `runtime().prompts` has exactly one entry, and it is the dispatch's prompt;
 *   - `runtime().executions` has exactly one entry, the command, even though the
 *     command crossed the wire three times;
 *   - the worker holds exactly ONE inbox row for those three transmissions;
 *   - every reported event id appears EXACTLY ONCE in the controller's stream,
 *     and the stream's positions are gapless;
 *   - every outbox row is retained and acknowledged, and none is duplicated.
 */
import { describe, expect, it } from "vitest"
import { FAULT_T0_MS, inboxOutcomeOf } from "../../src/mesh/fault/harness.js"
import { FAULT_MESH_ID, FAULT_PROJECT, FAULT_PROJECT_PATH, FAULT_RUN, heartbeatEnvelope } from "../../src/mesh/fault/records.js"
import { DELIVERY_BACKOFF_MS } from "../../src/mesh/outbox/policy.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../src/mesh/protocol/negotiation.js"
import { NO_FAULTS } from "../../src/mesh/fault/types.js"
import { nodeIdSchema } from "../../src/orchestration/identifiers.js"
import { EXECUTE_COMMAND_ID, anApprovedScenario, inboxRowCount, outboxRowCount, outboxStatuses } from "../unit/mesh/fault/fixtures.js"

const PROMPT = "Run the fault-harness dispatch"

describe("M4.9 acceptance: a run survives delay, drop, duplicate and partition", () => {
  it("enrols, advertises, executes, streams and resumes with no duplicate work", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      // ── Two nodes enrolled, and the second one's identity was DERIVED ──────
      // The harness enrols rather than naming a worker, so the node id below is
      // the one the enrollment code hashed to. Asserting against a literal here
      // would be asserting that a fixture typed a string.
      const enrolled = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(enrolled.ok).toBe(true)
      expect(enrolled.ok && enrolled.value?.node.meshId).toBe(FAULT_MESH_ID)
      expect(enrolled.ok && enrolled.value?.node.nodeId).toBe(mesh.workerNodeId)
      expect(mesh.workerNodeId).not.toBe(mesh.controllerNodeId)
      expect(nodeIdSchema.safeParse(mesh.workerNodeId).success).toBe(true)
      // A joined node that has never spoken is `never-seen`, which is what
      // makes the advertisement below observable at all.
      expect(enrolled.ok && enrolled.value?.liveness).toBe("never-seen")

      // ── Advertise, over a DELAYED link ────────────────────────────────────
      mesh.script([{ kind: "delay", ms: 400, match: { recordType: "mesh.heartbeat", after: 0, times: 1 } }])
      const heartbeat = heartbeatEnvelope({ nodeId: mesh.workerNodeId, sequence: 1, observedAtMs: FAULT_T0_MS })
      const advertised = await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: heartbeat }).then(
        () => undefined,
        (error: unknown) => error,
      )
      // The delay held the record off the wire, so the sender learned nothing
      // and the controller has not heard from the worker.
      expect((advertised as { code?: string } | undefined)?.code).toBe("fault.dropped")
      expect(mesh.proxy.pending).toBe(1)
      let stillUnknown = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(stillUnknown.ok && stillUnknown.value?.liveness).toBe("never-seen")

      await mesh.proxy.advance(400)
      expect(mesh.proxy.pending).toBe(0)
      const heartbeatTransmission = mesh.timeline().find((entry) => entry.recordType === "mesh.heartbeat")
      expect(heartbeatTransmission?.deliveries).toEqual([{ copy: 1, atMs: FAULT_T0_MS + 400, outcome: "delivered" }])

      const capability = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(capability.ok && capability.value?.liveness).toBe("live")
      const snapshot = capability.ok ? capability.value?.node.capability : null
      expect(snapshot?.runtimeKinds).toEqual(["opencode"])
      expect(snapshot?.capabilities).toEqual(["session.execute"])
      // The advertised path is the path the dispatch will name, which is the
      // whole point of advertising one.
      expect(snapshot?.projectPathIds).toEqual([FAULT_PROJECT_PATH])
      expect(snapshot?.negotiatedProtocolVersion).toBe(CURRENT_MESH_PROTOCOL_VERSION)
      expect(capability.ok && capability.value?.lastHeartbeatAt).toBe(new Date(FAULT_T0_MS).toISOString())

      // ── Execute the run, over a link that DELIVERS THE COMMAND THREE TIMES ──
      mesh.script([{ kind: "duplicate", times: 3, match: { recordType: "mesh.command", after: 0, times: 1 } }])
      const executed = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      expect(inboxOutcomeOf(executed)?.outcome).toBe("accepted")
      expect(mesh.timeline().filter((entry) => entry.recordType === "mesh.command").at(-1)?.deliveries).toHaveLength(3)

      // The runtime is handed the command once per delivered copy. A runtime
      // that re-ran its work on a redelivery is the duplicate this scenario is
      // built to detect, so the harness drives it that way on purpose.
      const launches = []
      for (let copy = 1; copy <= 3; copy += 1) {
        launches.push(await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT }))
      }
      expect(launches.map((launch) => launch.launched)).toEqual([true, false, false])
      const runtime = mesh.worker.runtime()
      const sessionId = launches[0]?.sessionId
      // EXACTLY ONE OF EACH. Three deliveries, one session, one prompt, one
      // execution, one inbox row.
      expect(runtime.sessions).toEqual([sessionId])
      expect(new Set(runtime.sessions).size).toBe(1)
      expect(runtime.prompts).toEqual([{ sessionId: String(sessionId), prompt: PROMPT }])
      expect(new Set(runtime.prompts.map((prompt) => `${prompt.sessionId}|${prompt.prompt}`)).size).toBe(1)
      expect(runtime.executions).toEqual([EXECUTE_COMMAND_ID])
      expect(await inboxRowCount(mesh)).toBe(1)
      expect(sessionId).toBe(`sess-${String(EXECUTE_COMMAND_ID)}`)

      // ── Report on the run, through drop, duplicate and delay ──────────────
      // One report per fault, in order, so each pump's outcome is a function of
      // the one rule it is exercising rather than of which rows happened to be
      // claimable. A report is only made once the previous one has settled,
      // because the ingestor refuses a sequence it has not seen the ones below
      // it for — and that refusal is a real property, not a nuisance to route
      // around, so the scenario does not put the mesh in that state.
      const reportedIds = ["evt-fault-report-1", "evt-fault-report-2", "evt-fault-report-3"]
      let transmissions = 0
      const countEventTransmissions = () => mesh.timeline().filter((entry) => entry.recordType === "mesh.event").length

      // Report 1, DROPPED. Nothing reached the controller and the row is
      // requeued with its attempt count intact.
      await mesh.worker.report(scenario.reportFor(1, sessionId))
      expect(outboxRowCount(mesh)).toBe(1)
      mesh.script([{ kind: "drop", match: { recordType: "mesh.event" } }])
      const dropped = await mesh.worker.deliverer().pumpOnce()
      expect(dropped.acknowledged).toBe(0)
      expect(dropped.requeued).toBe(1)
      expect(mesh.controller.ingested()).toHaveLength(0)
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(1)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "pending" })

      // Nothing is claimable before the backoff, and the backoff is a number in
      // a table rather than a timer in a process.
      const tooEarly = await mesh.worker.deliverer().pumpOnce()
      expect(tooEarly.claimed).toBe(0)
      expect(countEventTransmissions()).toBe(1)
      mesh.clock.advance((DELIVERY_BACKOFF_MS[0] ?? 1_000) + 1)

      // The retry, DELAYED and then overtaken by the clock. The sender is told
      // the write did not land and requeues, and the delayed copy is still
      // sitting in the proxy until the clock reaches its due instant — so the
      // same event is on the wire twice before the controller has seen it once.
      mesh.script([{ kind: "delay", ms: 300, match: { recordType: "mesh.event" } }])
      const delayed = await mesh.worker.deliverer().pumpOnce()
      expect(delayed.acknowledged).toBe(0)
      expect(delayed.requeued).toBe(1)
      expect(mesh.proxy.pending).toBe(1)
      expect(mesh.controller.ingested()).toHaveLength(0)
      expect(countEventTransmissions()).toBe(2)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "pending" })
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(2)

      await mesh.proxy.advance(300)
      expect(mesh.proxy.pending).toBe(0)
      // The late copy landed. The RETRY will therefore be a duplicate, and the
      // controller must answer it from the event id it already holds.
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1"])

      // The first event is still un-acknowledged, so the next pump redelivers it
      // AND the row has to be retired by the acknowledgement.
      mesh.script(NO_FAULTS)
      mesh.clock.advance((DELIVERY_BACKOFF_MS[1] ?? 2_000) + 1)
      const settled = await mesh.worker.deliverer().pumpOnce()
      expect(settled.acknowledged).toBe(1)
      expect(settled.outcomes[0]?.ack?.outcome).toBe("duplicate")
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "acknowledged" })
      // The redelivery converged: it is a THIRD transmission of the first report
      // and the controller still holds one copy.
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1"])
      expect(countEventTransmissions()).toBe(3)

      // ── The client connects, reads what is there, and DISCONNECTS ─────────
      // Read here, while one report has landed, so the cursor it holds is a
      // real one. Everything asserted about resuming below is a statement about
      // what arrives AFTER this point, which is what makes it a resume rather
      // than a first read.
      const connected = await mesh.controller.stream(0)
      expect(connected.map((entry) => entry.eventId)).toEqual(["evt-fault-report-1"])
      const cursor = connected.at(-1)?.position
      expect(cursor).toBe(1)

      // Report 2, DUPLICATED. All three copies cross the wire in one send.
      await mesh.worker.report(scenario.reportFor(2, sessionId))
      mesh.script([{ kind: "duplicate", times: 3, match: { recordType: "mesh.event" } }])
      const duplicated = await mesh.worker.deliverer().pumpOnce()
      expect(duplicated.acknowledged).toBe(1)
      expect(duplicated.outcomes[0]?.ack?.outcome).toBe("accepted")
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1", "evt-fault-report-2"])
      const duplicateTransmission = mesh.timeline().filter((entry) => entry.recordType === "mesh.event").at(-1)
      expect(duplicateTransmission?.deliveries).toHaveLength(3)
      expect(duplicateTransmission?.deliveries.every((delivery) => delivery.outcome === "delivered")).toBe(true)
      transmissions = countEventTransmissions()
      expect(transmissions).toBe(4)

      // Report 3, over a link that is CUT — and then healed.
      await mesh.worker.report(scenario.reportFor(3, sessionId))
      mesh.partition({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      const cut = await mesh.worker.deliverer().pumpOnce()
      expect(cut.acknowledged).toBe(0)
      expect(cut.requeued).toBe(1)
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1", "evt-fault-report-2"])
      const cutTransmission = mesh.timeline().filter((entry) => entry.recordType === "mesh.event").at(-1)
      expect(cutTransmission?.partitionActive).toBe(true)
      expect(cutTransmission?.deliveries).toEqual([{ copy: 1, atMs: cutTransmission?.sentAtMs, outcome: "partitioned" }])

      // The client is away: it read one entry and dropped. A `stream(null)` while
      // it is away is a NEW reader, not a resumption, and it is empty — which is
      // the reason a cursor exists.
      const secondReader = await mesh.controller.stream(null)
      expect(secondReader).toEqual([])

      mesh.clock.advance((DELIVERY_BACKOFF_MS[2] ?? 4_000) + 1)
      mesh.heal({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      const healed = await mesh.worker.deliverer().pumpOnce()
      expect(healed.acknowledged).toBe(1)
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(reportedIds)

      // NO DUPLICATE WORK: three reports, SIX transmissions between them, applied
      // three times.
      const ingestedIds = mesh.controller.ingested().map((event) => event.eventId)
      expect(ingestedIds).toHaveLength(3)
      expect(new Set(ingestedIds).size).toBe(3)
      expect(ingestedIds).toEqual(reportedIds)
      expect(mesh.worker.runtime().sessions).toEqual([sessionId])
      expect(mesh.worker.runtime().prompts).toHaveLength(1)
      expect(mesh.worker.runtime().executions).toEqual([EXECUTE_COMMAND_ID])
      expect(await inboxRowCount(mesh)).toBe(1)
      // SIX transmissions of three reports: one dropped, one delayed then
      // delivered late, one redelivered and suppressed, one tripled, one cut,
      // and one delivered after the heal.
      expect(countEventTransmissions()).toBe(6)
      expect(transmissions).toBe(4)

      // BOUNDED ROWS: three reports, three rows, every one retained and
      // acknowledged. A record is never deleted, so the count is the number
      // reported rather than the number pending — which is what makes a pump
      // that lost a row detectable here.
      expect(outboxRowCount(mesh)).toBe(3)
      expect(outboxStatuses(mesh)).toEqual({
        "mevt-evt-fault-report-1": "acknowledged",
        "mevt-evt-fault-report-2": "acknowledged",
        "mevt-evt-fault-report-3": "acknowledged",
      })

      // ── Stream ────────────────────────────────────────────────────────────
      const stream = await mesh.controller.stream(0)
      expect(stream.map((entry) => entry.eventId)).toEqual(reportedIds)
      // Gapless and in order, and each entry's `position` is the gateway's own
      // cursor rather than the sender's `localSequence`.
      expect(stream.map((entry) => entry.position)).toEqual([1, 2, 3])
      expect(stream.every((entry) => entry.runId === FAULT_RUN && entry.projectId === FAULT_PROJECT)).toBe(true)
      expect(stream.every((entry) => entry.sourceNodeId === mesh.workerNodeId)).toBe(true)

      // ── Resume after a disconnect ─────────────────────────────────────────
      // The client read position `cursor` above, the connection dropped, and
      // reports 2 and 3 arrived while it was away — one of them three times and
      // one of them across a cut link. Resuming from the cursor returns exactly
      // those two and re-sends nothing the client already has.
      expect(cursor).toBe(1)
      const resumed = await mesh.controller.resume(cursor ?? 0)
      expect(resumed.kind).toBe("resume")
      expect(resumed.kind === "resume" ? resumed.entries.map((entry) => entry.eventId) : null).toEqual(reportedIds.slice(1))
      expect(resumed.kind === "resume" ? resumed.from : null).toBe(2)
      expect(resumed.kind === "resume" ? resumed.head : null).toBe(3)

      // A cursor the gateway cannot honour is REFUSED rather than answered with
      // the head, because a client silently re-based onto the newest events
      // would be missing everything in between with nothing on the wire saying
      // so.
      const ahead = await mesh.controller.resume(99)
      expect(ahead.kind).toBe("refused")
      expect(ahead.kind === "refused" ? ahead.reason : null).toBe("cursor_ahead")
      expect(ahead.kind === "refused" ? ahead.error.retryable : null).toBe(false)
      // Re-reading from the same cursor a second time returns the same page, so
      // a reconnecting client converges rather than drifting — and the entries
      // are the two it had NOT seen, not the three the stream holds.
      const again = await mesh.controller.resume(cursor ?? 0)
      expect(again.kind === "resume" ? again.entries.map((entry) => entry.eventId) : null).toEqual(reportedIds.slice(1))
      // A client that had read everything and resumes from the head is told so
      // with an empty page rather than being handed the head again.
      const exhausted = await mesh.controller.resume(3)
      expect(exhausted.kind === "resume" ? exhausted.entries : null).toEqual([])

      // ── And the whole thing still works after a restart ──────────────────
      // A restarted controller rebuilds its projection from the durable log, so
      // the launch the runtime performed is still accounted for — which is the
      // assertion that the work was done and not merely reported.
      await mesh.restartNode(mesh.controllerNodeId)
      const rebuilt = mesh.controller.projection()
      expect(rebuilt?.run.runId).toBe(FAULT_RUN)
      expect(rebuilt?.approvals["approval-fault-1"]?.state).toBe("approved")
      expect(Object.keys(rebuilt?.tasks ?? {})).toEqual(["task-fault-1"])
      // The stream WINDOW survives the restart, which is the property this
      // assertion used to get wrong. It was written to say the opposite — that the
      // gateway came back empty and refused a pre-restart cursor with
      // `cursor_ahead` — because at the time the gateway WAS empty, and the test
      // was pinning the defect rather than the requirement.
      //
      // A position a client was handed before the restart must still name the
      // same event after it. `cursor_ahead` is the refusal reserved for "you are
      // reading a different stream", and a restarted process is emphatically not
      // a different stream: answering a valid cursor that way tells a correct
      // client its own history is fictional, and it does so silently, because
      // `cursor_ahead` is not an error the client will report.
      const afterRestart = await mesh.controller.resume(1)
      expect(afterRestart.kind).toBe("resume")
      expect(afterRestart.kind === "resume" ? afterRestart.entries.map((entry) => entry.eventId) : null).toEqual([
        "evt-fault-report-2",
        "evt-fault-report-3",
      ])
      // And the window is exactly the same window, not a fresh one that happens to
      // contain the same events: the head does not move, so a client that had
      // already seen the tail is not told it is behind.
      expect(afterRestart.kind === "resume" ? afterRestart.head : null).toBe(3)
      expect(await mesh.controller.stream(0)).toHaveLength(3)
      // The durable rows are all still there, which is the part a restart must
      // not lose.
      expect(await inboxRowCount(mesh)).toBe(1)
      expect(outboxRowCount(mesh)).toBe(3)
      expect(mesh.worker.runtime().sessions).toEqual([sessionId])
      expect(mesh.worker.runtime().prompts).toHaveLength(1)
      // No fault in this scenario CRASHED a node. A boundary that had fired an
      // `InjectedCrash` would have left one in this list, and the run's survival
      // would then be a statement about the crash paths rather than about the
      // transport.
      expect(mesh.boundary.crashes).toEqual([])
    } finally {
      mesh.close()
    }
  })
})

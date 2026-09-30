/**
 * At-least-once delivery, once.
 *
 * The mesh's answer to a lost acknowledgement is to send the same command again,
 * which is only safe because the receiver converges. This file is that claim
 * measured twice — once with the retransmissions the SENDER makes deliberately
 * (five separate `send`s, each signed afresh) and once with the retransmission a
 * real network makes (the `duplicate` fault's five re-signed copies of ONE
 * send) — because a suite that only drove one of them would be measuring the
 * transport OR the inbox and calling it convergence.
 */
import { describe, expect, it } from "vitest"
import { inboxOutcomeOf } from "../../../../src/mesh/fault/harness.js"
import type { CommandId } from "../../../../src/orchestration/identifiers.js"
import { EXECUTE_COMMAND_ID, anApprovedScenario, inboxRowCount } from "./fixtures.js"

const PROMPT = "Run the fault-harness dispatch"

describe("retry convergence", () => {
  it("five deliberate retransmissions of one command produce one session, one execution and one inbox row", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const record = scenario.executeRecord(1)
      const send = () => mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })

      const first = inboxOutcomeOf(await send())
      expect(first?.outcome).toBe("accepted")
      expect(first?.commandId).toBe(EXECUTE_COMMAND_ID)
      const acceptedSequence = first?.outcome === "accepted" ? first.acceptedSequence : -1

      // The runtime runs the command once, and the effect is recorded against
      // the durable inbox row. This is the moment a redelivery has to converge
      // onto: the row now carries a result.
      const applied = await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT })
      expect(applied.launched).toBe(true)

      const rest = []
      for (let attempt = 0; attempt < 4; attempt += 1) rest.push(inboxOutcomeOf(await send()))

      // Every retransmission is a DUPLICATE, carrying the sequence the first
      // arrival was given rather than a new one.
      expect(rest.map((outcome) => outcome?.outcome)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"])
      expect(rest.map((outcome) => (outcome?.outcome === "duplicate" ? outcome.acceptedSequence : -1))).toEqual([
        acceptedSequence,
        acceptedSequence,
        acceptedSequence,
        acceptedSequence,
      ])

      // RESPONSES 2..5 EQUAL RESPONSE 1'S STORED RESULT — byte for byte, and not
      // merely "also a duplicate". A redelivery that recomputed its answer would
      // be indistinguishable from a second instruction at the peer.
      const stored = rest[0]?.outcome === "duplicate" ? rest[0].storedResult : undefined
      expect(stored).toEqual({ sessionId: applied.sessionId })
      for (const outcome of rest) expect(outcome?.outcome === "duplicate" ? outcome.storedResult : undefined).toEqual(stored)
      // The acks agree with each other too, so a controller reading four
      // acknowledgements sees one delivery acknowledged four times.
      const acks = rest.map((outcome) => (outcome?.outcome === "duplicate" ? outcome.ack : undefined))
      for (const ack of acks) expect(ack).toEqual(acks[0])
      expect(acks[0]?.outcome).toBe("duplicate")

      // AND THE WORK WAS DONE ONCE.
      const runtime = mesh.worker.runtime()
      expect(runtime.executions).toEqual([EXECUTE_COMMAND_ID])
      expect(runtime.sessions).toEqual([applied.sessionId])
      expect(runtime.prompts).toEqual([{ sessionId: applied.sessionId, prompt: PROMPT }])
      expect(await inboxRowCount(mesh)).toBe(1)

      // The runtime is handed the command once per DELIVERY — a runtime that
      // re-ran its work on a redelivery would be the duplicate this suite is
      // looking for — and the durable inbox row is what stops the second.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT })).toEqual({ sessionId: applied.sessionId, launched: false })
      }
      expect(mesh.worker.runtime().executions).toHaveLength(1)
      expect(mesh.worker.runtime().sessions).toHaveLength(1)
      expect(mesh.worker.runtime().prompts).toHaveLength(1)

      // NON-VACUITY: five transmissions really did cross the wire. Without the
      // retransmissions there is one, and the assertions above would be about a
      // single arrival.
      const transmissions = mesh.timeline().filter((entry) => entry.recordType === "mesh.command")
      expect(transmissions).toHaveLength(5)
      expect(transmissions.every((entry) => entry.deliveries.length === 1 && entry.deliveries[0]?.outcome === "delivered")).toBe(true)
      expect(new Set(transmissions.map((entry) => entry.sequence)).size).toBe(5)
      expect(mesh.proxy.pending).toBe(0)
    } finally {
      mesh.close()
    }
  })

  it("the `duplicate` fault's five re-signed copies of ONE send converge the same way", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      mesh.script([{ kind: "duplicate", times: 5, match: { recordType: "mesh.command" } }])
      const response = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      expect(inboxOutcomeOf(response)?.outcome).toBe("accepted")

      const first = await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT })
      expect(first.launched).toBe(true)
      // The runtime is handed the command once per delivered copy.
      for (let copy = 2; copy <= 5; copy += 1) {
        expect(await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT })).toEqual({ sessionId: first.sessionId, launched: false })
      }

      const runtime = mesh.worker.runtime()
      expect(runtime.executions).toEqual([EXECUTE_COMMAND_ID])
      expect(runtime.sessions).toEqual([first.sessionId])
      expect(runtime.prompts).toEqual([{ sessionId: first.sessionId, prompt: PROMPT }])
      // The row's effect state advanced exactly once across five deliveries,
      // and the inbox holds ONE row for the five.
      expect(await inboxRowCount(mesh)).toBe(1)
      const stored = await mesh.worker.inbox.lookup(EXECUTE_COMMAND_ID)
      expect(stored.ok && stored.value?.acceptedSequence).toBe(1)
      expect(stored.ok && stored.value?.effectState).toBe("result_recorded")
      // NON-VACUITY: five copies were delivered, not one.
      const duplicated = mesh.timeline().find((entry) => entry.recordType === "mesh.command")
      expect(duplicated?.deliveries).toHaveLength(5)
    } finally {
      mesh.close()
    }
  })

  it("a command that arrives BEFORE its effect has run converges on the inbox's dedupe, and still runs once", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      // The harder ordering: the row is durable but carries no result yet, so
      // the redelivery cannot be answered from storage. It converges on the
      // INBOX's dedupe instead — same row, same sequence, no second row.
      const record = scenario.executeRecord(1)
      const first = inboxOutcomeOf(await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record }))
      const second = inboxOutcomeOf(await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record }))

      expect(first?.outcome).toBe("accepted")
      expect(second?.outcome).toBe("duplicate")
      expect(second?.outcome === "duplicate" ? second.acceptedSequence : -1).toBe(first?.outcome === "accepted" ? first.acceptedSequence : -1)
      expect(await inboxRowCount(mesh)).toBe(1)
      const stored = await mesh.worker.inbox.lookup(EXECUTE_COMMAND_ID)
      // The honest state: a row that has been ADMITTED and not yet run. The
      // inbox claims less than is true, which is what makes a crash here
      // recoverable rather than a claim of work that never happened.
      expect(stored.ok && stored.value?.effectState).toBe("not_started")
      expect(stored.ok && stored.value?.resultJson).toBeNull()

      // And the effect, run once for the one row.
      const applied = await mesh.worker.applyCommand(EXECUTE_COMMAND_ID as CommandId, { prompt: PROMPT })
      expect(applied.launched).toBe(true)
      expect(await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: PROMPT })).toEqual({ sessionId: applied.sessionId, launched: false })
      expect(mesh.worker.runtime().executions).toEqual([EXECUTE_COMMAND_ID])
    } finally {
      mesh.close()
    }
  })
})

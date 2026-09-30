/**
 * The epoch gate, at the wire.
 *
 * Two refusals and one acceptance, on a worker that is demonstrably holding the
 * lease the command claims. That third case is the whole point of this file: a
 * test that only sends stale commands passes just as happily against a worker
 * that refuses everything, which is a bug, not a fence.
 *
 * The claim each refusal rests on is the same one: NOTHING is persisted. The
 * inbox row count is asserted UNCHANGED rather than merely "not incremented",
 * because "not incremented" would also be true of a gate that wrote a row and
 * then refused.
 */
import { describe, expect, it } from "vitest"
import { deliverALease as takeOverLease, inboxOutcomeOf, type FaultMesh } from "../../../../src/mesh/fault/harness.js"
import type { CommandInboxOutcome } from "../../../../src/mesh/inbox/types.js"
import { aFaultScenario, deliverALease, inboxRowCount } from "./fixtures.js"

/** Delivers the epoch-1 claim and then the epoch-2 takeover, to both nodes. */
async function takeOverToEpoch2(mesh: FaultMesh): Promise<void> {
  await deliverALease(mesh)
  const takeover = await takeOverLease(mesh, {
    epoch: 2,
    operation: "takeover",
    predecessorLeaseId: "lease-run-fault-1-e1",
    predecessorEpoch: 1,
    takeoverReason: "the operator has seen the nodes this controller could not reach",
    acknowledgedUnreconciledNodeIds: [mesh.workerNodeId],
  })
  expect((takeover.worker as { result?: { outcome?: string } }).result?.outcome).toBe("accepted")
  expect(await mesh.worker.heldLease()).toMatchObject({ epoch: 2, controllerNodeId: mesh.controllerNodeId })
}

function refusalOf(response: unknown): Extract<CommandInboxOutcome, { outcome: "refused" }> {
  const outcome = inboxOutcomeOf(response)
  if (outcome?.outcome !== "refused") throw new Error(`expected a refusal, got '${String(outcome?.outcome)}'`)
  return outcome
}

describe("stale epoch", () => {
  it("refuses a lower-epoch command and persists NOTHING", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      await takeOverToEpoch2(mesh)
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(2)).ok).toBe(true)

      const rowsBefore = await inboxRowCount(mesh)
      expect(rowsBefore).toBe(0)

      const response = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      const refusal = refusalOf(response)

      expect(refusal.stage).toBe("gate")
      expect(refusal.error.code).toBe("epoch.stale")
      expect(refusal.error.category).toBe("stale_epoch")
      expect(refusal.error.retryable).toBe(false)
      // A refusal carries no `commandId`: the gate refused before the record was
      // parsed into a command identity, so there is nothing to record.
      expect(refusal.commandId).toBeNull()
      expect(refusal.error.message).toContain("NOTHING is persisted")

      // THE ASSERTION: the row count is UNCHANGED. A gate that stored the stale
      // command for later would be a queue, and a queue is what the plan forbids.
      expect(await inboxRowCount(mesh)).toBe(rowsBefore)
      expect(await mesh.worker.inboxRows.nextAcceptedSequence()).toEqual({ ok: true, value: 1 })
      expect(mesh.worker.runtime().executions).toEqual([])
    } finally {
      mesh.close()
    }
  })

  it("refuses a higher-epoch command without the explicit takeover, and persists NOTHING", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      await takeOverToEpoch2(mesh)
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(2)).ok).toBe(true)

      const rowsBefore = await inboxRowCount(mesh)

      const response = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        // A higher epoch is only ever accepted through a LEASE, never by a
        // command arriving first — so a controller that has fenced nobody and
        // simply claims epoch 3 is refused even though 3 is above 2.
        record: scenario.executeRecord(3, { leaseId: "lease-run-fault-1-e2" }),
      })
      const refusal = refusalOf(response)

      expect(refusal.stage).toBe("gate")
      expect(refusal.error.code).toBe("epoch.unregistered")
      expect(refusal.error.category).toBe("conflict")
      expect(refusal.error.retryable).toBe(false)
      expect(refusal.error.message).toContain("explicit lease takeover")
      expect(await inboxRowCount(mesh)).toBe(rowsBefore)
      expect(mesh.worker.runtime().executions).toEqual([])
    } finally {
      mesh.close()
    }
  })

  it("admits the command at the epoch the worker actually holds, which is what makes the two refusals a fence", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      await takeOverToEpoch2(mesh)
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(2)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(2)).ok).toBe(true)

      // NON-VACUITY: the SAME payload at the held epoch is admitted. A gate that
      // refused everything would pass both refusals above and fail here.
      const accepted = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(2),
      })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)

      // And the three epochs differ only in the number they carry: the wire
      // records for them are otherwise the same bytes.
      const epochs = [
        scenario.executeRecord(1),
        scenario.executeRecord(2),
        scenario.executeRecord(3, { leaseId: "lease-run-fault-1-e2" }),
      ].map((record) => (record.payload as { controllerEpoch: number }).controllerEpoch)
      expect(epochs).toEqual([1, 2, 3])
    } finally {
      mesh.close()
    }
  })

  it("a stale command refused once is refused identically forever, and never becomes acceptable later", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      await deliverALease(mesh)
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(1)).ok).toBe(true)

      // First the command at the epoch the worker holds: admitted.
      expect(
        inboxOutcomeOf(await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: scenario.executeRecord(1) }))?.outcome,
      ).toBe("accepted")

      // Then the controller is superseded, and the same command id at epoch 1 is
      // stale for ever. A node that could be "catching up" on a stale command
      // would be the exact defect the gate exists to prevent.
      const takeover = await takeOverLease(mesh, {
        epoch: 2,
        operation: "takeover",
        predecessorLeaseId: "lease-run-fault-1-e1",
        predecessorEpoch: 1,
        takeoverReason: "the operator has seen the nodes this controller could not reach",
        acknowledgedUnreconciledNodeIds: [mesh.workerNodeId],
      })
      expect((takeover.worker as { result?: { outcome?: string } }).result?.outcome).toBe("accepted")

      const rowsBefore = await inboxRowCount(mesh)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refusal = refusalOf(
          await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: scenario.executeRecord(1) }),
        )
        expect(refusal.error.code).toBe("epoch.stale")
      }
      // The command that WAS admitted at epoch 1 keeps its row; the refusals add
      // nothing. A gate that re-evaluated stored rows would retire it here.
      expect(await inboxRowCount(mesh)).toBe(rowsBefore)
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })
})

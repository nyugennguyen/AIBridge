/**
 * A partition, at the TRANSPORT.
 *
 * The controller/worker matrix — "under every partition, at most one controller
 * may create new work for a run" — is `tests/unit/mesh/lease/split-brain.test.ts`,
 * which enumerates 256 link configurations against two controllers and three
 * workers each holding their own lease store. That is the AUTHORITY question and
 * it belongs there; repeating it here would be a second, weaker copy of the same
 * claim.
 *
 * What is left, and what this file is about, is the DELIVERY question: while a
 * link is cut a record does not move, the sender learns exactly one thing — that
 * it did not land — and nothing is queued on the far side to be delivered later.
 */
import { describe, expect, it } from "vitest"
import { inboxOutcomeOf, leaseOutcomeOf } from "../../../../src/mesh/fault/harness.js"
import { aLegacyJob, heartbeatEnvelope } from "../../../../src/mesh/fault/records.js"
import { DELIVERY_BACKOFF_MS } from "../../../../src/mesh/outbox/policy.js"
import { EXECUTE_COMMAND_ID, aFaultScenario, anApprovedScenario, deliverALease, faultCode, inboxRowCount, outboxRowCount, outboxStatuses } from "./fixtures.js"

describe("partition", () => {
  it("no command can be CREATED while the controller cannot reach the worker, and one can the moment the link returns", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const record = scenario.executeRecord(1)
      mesh.partition()

      const cut = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
        .then(() => undefined, (error: unknown) => error)

      // The sender learns ONE thing: the write did not land. The refusal is
      // retryable and names the link, which is all a sender can honestly know.
      expect(faultCode(cut)).toBe("fault.partitioned")
      expect((cut as { retryable?: boolean }).retryable).toBe(true)
      expect(String((cut as { message?: string }).message)).toContain(`${String(mesh.controllerNodeId)} -> ${String(mesh.workerNodeId)}`)
      // NOTHING was persisted on the far side, and nothing is queued to be
      // persisted later: a cut link is not a buffer.
      expect(await inboxRowCount(mesh)).toBe(0)
      expect(mesh.proxy.pending).toBe(0)
      const transmission = mesh.timeline().find((entry) => entry.recordType === "mesh.command")
      expect(transmission?.partitionActive).toBe(true)
      expect(transmission?.deliveries).toEqual([{ copy: 1, atMs: transmission?.sentAtMs, outcome: "partitioned" }])

      // NON-VACUITY: the identical record, on the identical node, once the link
      // is back. Nothing about the command changed — only reachability did.
      mesh.heal()
      const healed = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
      expect(inboxOutcomeOf(healed)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a lease the worker never received is a lease the worker does not hold", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      // The controller's own coordination needs no link: the kernel log is
      // local, so the run, the proposal and the approval are all recorded while
      // the wire is cut.
      mesh.partition()
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(1)).ok).toBe(true)
      expect(mesh.controller.projection()?.dispatches["dispatch-fault-1"]?.lifecycleState).toBe("approved")

      // The controller applies the claim to its OWN store and the record still
      // has to cross the wire, because a worker does not claim a lease: it is
      // TOLD which controller drives the run.
      const cut = await deliverALease(mesh).then(() => undefined, (error: unknown) => error)
      expect(faultCode(cut)).toBe("fault.partitioned")
      // A controller that believes it is the controller and a worker that holds
      // nothing is precisely the state a partition creates.
      expect(await mesh.worker.heldLease()).toBeNull()
      const command = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: scenario.executeRecord(1) })
        .then(() => undefined, (error: unknown) => error)
      expect(faultCode(command)).toBe("fault.partitioned")
      expect(await inboxRowCount(mesh)).toBe(0)

      // Once the link returns the same two records land, in order, and the
      // command is admitted against the lease the worker now holds.
      mesh.heal()
      const healed = await deliverALease(mesh)
      expect(leaseOutcomeOf(healed.worker)?.outcome).toBe("accepted")
      expect(await mesh.worker.heldLease()).toMatchObject({ epoch: 1, controllerNodeId: mesh.controllerNodeId })
      const accepted = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: scenario.executeRecord(1) })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a cut link in the OTHER direction strands the worker's report, and the backoff brings it back after the heal", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const accepted = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      const applied = await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: "Run the fault-harness dispatch" })
      expect(applied.sessionId).toBe(`sess-${String(EXECUTE_COMMAND_ID)}`)
      await mesh.worker.report(scenario.reportFor(1, applied.sessionId))

      // Only the reporting direction is cut, which is the half-healed case a
      // symmetric model would miss entirely.
      mesh.partition({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      const failed = await mesh.worker.deliverer().pumpOnce()
      expect(failed.acknowledged).toBe(0)
      expect(failed.requeued).toBe(1)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "pending" })
      // `attempts` was NOT reset by the failure: this is what makes the poison
      // threshold reachable rather than a message that retries forever.
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(1)
      expect(mesh.controller.ingested()).toHaveLength(0)

      // Nothing may be claimed before the backoff elapses, and the backoff is a
      // number in a table rather than a timer in a process.
      const tooEarly = await mesh.worker.deliverer().pumpOnce()
      expect(tooEarly.claimed).toBe(0)
      expect(tooEarly.requeued).toBe(0)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "pending" })
      mesh.clock.advance((DELIVERY_BACKOFF_MS[0] ?? 1_000) + 1)

      mesh.heal({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      const healed = await mesh.worker.deliverer().pumpOnce()
      // NON-VACUITY: the same report, one backoff later, over a healed link. The
      // row it produced is the one that was requeued above.
      expect(healed.acknowledged).toBe(1)
      expect(healed.outcomes[0]?.disposition).toBe("acknowledged")
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(2)
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1"])
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "acknowledged" })
      expect(outboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a partition does not reach anything that never needed the wire", async () => {
    const scenario = await aFaultScenario()
    const mesh = scenario.mesh
    try {
      mesh.partition()
      // The kernel log is local, so a run is created, proposed and approved
      // under a full partition and only the DELIVERY of the command waits.
      expect(mesh.controller.coordinator.submit(scenario.runCreateFor(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.proposeCommand(1)).ok).toBe(true)
      expect(mesh.controller.coordinator.submit(scenario.approveCommand(1)).ok).toBe(true)
      expect(mesh.controller.projection()?.approvals["approval-fault-1"]?.state).toBe("approved")
      expect(await mesh.worker.heldLease()).toBeNull()

      // Translation is a local route over a local store, so it too is untouched
      // by a cut wire — which is exactly why hook 8 is unreachable from the
      // transport and needed a method of its own on the harness.
      expect(mesh.translateLegacyTrigger(aLegacyJob()).ok).toBe(true)

      const heartbeat = heartbeatEnvelope({ nodeId: mesh.workerNodeId, sequence: 1, observedAtMs: mesh.clock.now() })
      await expect(mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: heartbeat })).rejects.toMatchObject({
        code: "fault.partitioned",
      })
      const advertised = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(advertised.ok && advertised.value?.liveness).toBe("never-seen")
    } finally {
      mesh.close()
    }
  })
})

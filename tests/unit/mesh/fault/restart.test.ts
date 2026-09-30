/**
 * A process restart, and what it is obliged to keep.
 *
 * The plan's requirement is "worker restart preserves inbox/outbox and
 * active-session references", and the plan's failure diagram adds the case a
 * healthy long-running process also hits: a delivery that died holding a claim
 * strands an outbox row in `sending`, and only a later cycle may reclaim it.
 *
 * Both are only meaningful because the restart here is a REAL one — every seam's
 * database handles are closed and reopened over the SAME paths. An in-memory
 * store that survived would make every assertion here vacuous, and one that did
 * not survive would be a cache. The file paths are asserted for exactly that
 * reason.
 */
import { describe, expect, it } from "vitest"
import { inboxOutcomeOf } from "../../../../src/mesh/fault/harness.js"
import { MESH_OUTBOX_CLAIM_LEASE_MS } from "../../../../src/mesh/outbox/policy.js"
import { EXECUTE_COMMAND_ID, anApprovedScenario, inboxRowCount, outboxRowCount, outboxStatuses } from "./fixtures.js"

describe("restart", () => {
  it("a worker restart preserves the inbox row, the outbox row and the active session", async () => {
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
      expect(applied.launched).toBe(true)
      await mesh.worker.report(scenario.reportFor(1, applied.sessionId))

      const listed = await mesh.worker.inboxRows.listInbox({})
      if (!listed.ok) throw new Error(`the worker's inbox could not be read: ${listed.error.code} — ${listed.error.message}`)
      const before = {
        files: { ...mesh.worker.files },
        row: listed.value[0],
        outbox: mesh.worker.outboxRows.list({}).map((record) => ({ id: record.outboxId, status: record.status, attempts: record.attempts, payload: record.payloadJson })),
        lease: await mesh.worker.heldLease(),
      }
      expect(before.row).toBeDefined()
      expect(before.outbox).toHaveLength(1)

      await mesh.restartNode(mesh.workerNodeId)

      // The restart reopened the SAME files. Asserted because a harness that
      // rebuilt over fresh paths would find empty databases and call that
      // "preserved".
      expect(mesh.worker.files).toEqual(before.files)

      const after = await mesh.worker.inboxRows.listInbox({})
      expect(after.ok && after.value).toHaveLength(1)
      const row = after.ok ? after.value[0] : undefined
      expect(row?.commandId).toBe(EXECUTE_COMMAND_ID)
      expect(row?.effectState).toBe("result_recorded")
      expect(row?.resultJson).toBe(JSON.stringify({ sessionId: applied.sessionId }))
      // Byte-for-byte the same row, including the instant it became durable and
      // the sequence it was given. A rebuilt row would carry a fresh timestamp
      // and a new sequence, which is what a command recorded twice would look
      // like.
      expect(row).toEqual(before.row)

      expect(mesh.worker.outboxRows.list({}).map((record) => ({ id: record.outboxId, status: record.status, attempts: record.attempts, payload: record.payloadJson }))).toEqual(before.outbox)
      expect(outboxRowCount(mesh)).toBe(1)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "pending" })

      // The active-session reference survived as DURABLE state, not as memory:
      // the row above still carries the result, so a redelivery after the
      // restart is answered from storage.
      expect(await mesh.worker.heldLease()).toEqual(before.lease)
      expect(await mesh.worker.applyCommand(EXECUTE_COMMAND_ID, { prompt: "Run the fault-harness dispatch" })).toEqual({
        sessionId: applied.sessionId,
        launched: false,
      })
      // NON-VACUITY: the runtime's observations live OUTSIDE the rebuilt seams,
      // so they are not a thing the restart could have lost — the DURABLE row
      // is, and it is what refused the second launch.
      expect(mesh.worker.runtime().sessions).toEqual([applied.sessionId])
      expect(mesh.worker.runtime().executions).toEqual([EXECUTE_COMMAND_ID])
      expect(mesh.worker.runtime().prompts).toHaveLength(1)

      // And the row the restart preserved is still a live authorization: the
      // redelivered command is answered from it.
      const redelivered = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      const duplicate = inboxOutcomeOf(redelivered)
      expect(duplicate?.outcome).toBe("duplicate")
      expect(duplicate?.outcome === "duplicate" ? duplicate.storedResult : undefined).toEqual({ sessionId: applied.sessionId })
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a claim stranded in `sending` survives the restart and is reclaimed when its lease expires", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      await mesh.worker.report(scenario.reportFor(1, "sess-fault-1"))
      // Claimed through the store's own primitive rather than by provoking a
      // crash: the case under test is a claim that is stranded for any reason
      // at all, and hooks 5 and 6 already cover the two the plan names.
      const claim = mesh.worker.outboxRows.claimPending({
        now: new Date(mesh.clock.now()).toISOString(),
        leaseMs: MESH_OUTBOX_CLAIM_LEASE_MS,
        limit: 10,
        readyAt: new Date(mesh.clock.now()).toISOString(),
      })
      expect(claim.records).toHaveLength(1)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "sending" })
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(1)

      await mesh.restartNode(mesh.workerNodeId)
      // A restart does not unstick a claim: the row is durable, so it is still
      // `sending` and still held by a claim token the new process does not have.
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "sending" })

      const tooEarly = await mesh.worker.deliverer().pumpOnce()
      expect(tooEarly.reclaimed).toEqual([])
      expect(tooEarly.claimed).toBe(0)
      expect(mesh.controller.ingested()).toHaveLength(0)

      mesh.clock.advance(MESH_OUTBOX_CLAIM_LEASE_MS + 1)
      const reclaimed = await mesh.worker.deliverer().pumpOnce()
      // NON-VACUITY: the reclaim is what delivered it. `attempts` reached 2 and
      // was not reset by the recovery, which is what keeps a message that
      // crashes the process on every attempt on its way to terminal.
      expect(reclaimed.reclaimed).toEqual(["mevt-evt-fault-report-1"])
      expect(reclaimed.acknowledged).toBe(1)
      expect(mesh.worker.outboxRows.list({})[0]?.attempts).toBe(2)
      expect(outboxStatuses(mesh)).toEqual({ "mevt-evt-fault-report-1": "acknowledged" })
      expect(mesh.controller.ingested().map((event) => event.eventId)).toEqual(["evt-fault-report-1"])
      expect(outboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a controller restart rebuilds its projection and its lease history from the durable log", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const before = mesh.controller.projection()
      const files = { ...mesh.controller.files }
      const history = await mesh.controller.leaseHistory(scenario.mesh.scope)
      expect(history.ok && history.value).toHaveLength(1)
      // Touch the projection so a cache would be observably warm.
      expect(before?.run.runId).toBeDefined()

      await mesh.restartNode(mesh.controllerNodeId)
      expect(mesh.controller.files).toEqual(files)

      // Replayed from the kernel log, not carried in memory: the engine is a new
      // object over the same bytes.
      const after = mesh.controller.projection()
      expect(after?.run.runId).toBe(before?.run.runId)
      expect(after?.stateDigest).toBe(before?.stateDigest)
      expect(Object.keys(after?.dispatches ?? {})).toEqual(Object.keys(before?.dispatches ?? {}))
      expect(after?.approvals["approval-fault-1"]?.state).toBe("approved")
      expect(Object.keys(after?.tasks ?? {})).toHaveLength(1)

      const historyAfter = await mesh.controller.leaseHistory(mesh.scope)
      expect(historyAfter.ok && historyAfter.value).toHaveLength(1)
      expect(historyAfter.ok ? historyAfter.value[0]?.leaseId : undefined).toBe(history.ok ? history.value[0]?.leaseId : undefined)

      // And the recovered controller still coordinates: a command submitted
      // after the restart lands in the same log the projection was rebuilt from.
      const accepted = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: scenario.executeRecord(1),
      })
      // NON-VACUITY: the worker's gate resolves the command's state against the
      // controller's REBUILT projection, so a controller that lost its
      // projection would refuse this with a state-precondition error rather than
      // admit it.
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a node killed mid-flight accepts nothing until it is restarted, and the same command then works", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const record = scenario.executeRecord(1)
      mesh.killNode(mesh.workerNodeId)
      const refused = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
        .then(() => undefined, (error: unknown) => error)
      expect((refused as { code?: string }).code).toBe("fault.node_down")
      // The refusal is retryable but a RETRY DOES NOT HELP: only a restart can
      // make a dead process accept a record, and the message says so.
      expect((refused as { message?: string }).message).toContain("restart")
      expect(await inboxRowCount(mesh)).toBe(0)

      await mesh.restartNode(mesh.workerNodeId)
      const accepted = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })
})

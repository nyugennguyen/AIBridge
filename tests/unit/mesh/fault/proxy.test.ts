import { describe, expect, it } from "vitest"
import { FAULT_T0_MS, inboxOutcomeOf } from "../../../../src/mesh/fault/harness.js"
import { MeshFaultProxy } from "../../../../src/mesh/fault/proxy.js"
import { NO_FAULTS, ScriptedClock, type TransmissionRecord } from "../../../../src/mesh/fault/types.js"
import { FAULT_MESH_ID, heartbeatEnvelope } from "../../../../src/mesh/fault/records.js"
import { aNodeIdentity } from "../../../../src/mesh/fault/transport.js"
import { nodeIdSchema, type NodeId } from "../../../../src/orchestration/identifiers.js"
import type { MeshRequestSignature } from "../../../../src/mesh/identity/index.js"
import { anApprovedScenario, faultCode, inboxRowCount } from "./fixtures.js"

/**
 * The proxy's five faults, each asserted as a CHANGE IN THE OBSERVED TIMELINE.
 *
 * The control arm is either the same mesh with the same record and an empty
 * script, or another transmission in the same timeline that was moved under
 * `NO_FAULTS`, because a fault test that only ever runs the faulted arm cannot
 * tell a fault that worked from a property that was always true.
 */
describe("MeshFaultProxy", () => {
  it("a `delay` holds a record off the wire until its due instant, and the sender is told it has not landed", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const sentAtMs = mesh.clock.now()
      mesh.script([{ kind: "delay", ms: 750, match: { recordType: "mesh.command" } }])
      const refused = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: scenario.executeRecord(1) })
        .then(() => undefined, (error: unknown) => error)

      expect(faultCode(refused)).toBe("fault.dropped")
      // The refusal is RETRYABLE, because the fault being modelled is a packet
      // still in flight rather than one that will never arrive.
      expect((refused as { retryable?: boolean }).retryable).toBe(true)
      expect(mesh.proxy.pending).toBe(1)
      expect(await inboxRowCount(mesh)).toBe(0)

      const held = transmissionOf(mesh, "mesh.command")
      expect(held.fault).toBe("delay")
      expect(held.dueAtMs - held.sentAtMs).toBe(750)
      expect(held.deliveries).toHaveLength(0)
      expect(held.sentAtMs).toBe(sentAtMs)

      await mesh.proxy.advance(750)

      expect(mesh.proxy.pending).toBe(0)
      const released = transmissionOf(mesh, "mesh.command")
      expect(released.deliveries).toEqual([{ copy: 1, atMs: sentAtMs + 750, outcome: "delivered" }])
      // NON-VACUITY: the receiver saw nothing until the clock reached the due
      // instant, and the same record is admitted the moment it does.
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("a `drop` refuses the sender, records the drop, and never reaches the receiver", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const record = scenario.executeRecord(1)
      mesh.script([{ kind: "drop", match: { recordType: "mesh.command" } }])
      const refused = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
        .then(() => undefined, (error: unknown) => error)

      expect(faultCode(refused)).toBe("fault.dropped")
      expect(mesh.proxy.pending).toBe(0)
      expect(await inboxRowCount(mesh)).toBe(0)
      const dropped = transmissionOf(mesh, "mesh.command")
      expect(dropped.fault).toBe("drop")
      expect(dropped.deliveries).toEqual([{ copy: 1, atMs: dropped.sentAtMs, outcome: "dropped" }])

      // NON-VACUITY: the identical record, on the identical node, with the script
      // emptied. Nothing about the command changed — only the wire did.
      mesh.script(NO_FAULTS)
      const accepted = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
      expect(transmissionOf(mesh, "mesh.command", 2).fault).toBe("none")
    } finally {
      mesh.close()
    }
  })

  it("a `duplicate` re-signs every copy past the first, and the inbox converges onto one row", async () => {
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
      const duplicated = transmissionOf(mesh, "mesh.command")
      expect(duplicated.fault).toBe("duplicate")
      expect(duplicated.deliveries.map((delivery) => delivery.copy)).toEqual([1, 2, 3, 4, 5])
      expect(duplicated.deliveries.every((delivery) => delivery.outcome === "delivered")).toBe(true)
      expect(mesh.proxy.pending).toBe(0)
      expect(await inboxRowCount(mesh)).toBe(1)

      // NON-VACUITY: the lease the scenario delivered under an EMPTY script is
      // still in the same timeline with exactly one copy, so the five above are
      // the fault and not the harness.
      const lease = mesh.timeline().find((entry) => entry.recordType === "mesh.lease")
      expect(lease?.deliveries).toHaveLength(1)
      expect(lease?.fault).toBe("none")
    } finally {
      mesh.close()
    }
  })

  it("a `reorder` inverts the order two transmissions are delivered in", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      // The first heartbeat is overtaken by a second one sent immediately after,
      // which is the only thing a reorder IS: a delay long enough to be passed.
      mesh.script([{ kind: "reorder", ms: 500, match: { recordType: "mesh.heartbeat", after: 0, times: 1 } }])
      const beat = (sequence: number) => heartbeatEnvelope({ nodeId: mesh.workerNodeId, sequence, observedAtMs: mesh.clock.now() })

      const overtaken = await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: beat(1) }).then(() => undefined, (error: unknown) => error)
      expect(faultCode(overtaken)).toBe("fault.dropped")
      expect(mesh.proxy.pending).toBe(1)

      await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: beat(2) })

      const beats = mesh.timeline().filter((entry) => entry.recordType === "mesh.heartbeat")
      expect(beats).toHaveLength(2)
      expect(beats[0]?.fault).toBe("reorder")
      expect(beats[1]?.fault).toBe("none")
      // The ORDER is inverted, and the order is the only thing asserted: the
      // first-sent transmission is still the last one to be delivered.
      expect(beats[0]?.deliveries).toHaveLength(0)
      expect(beats[1]?.deliveries[0]?.outcome).toBe("delivered")
      expect(mesh.proxy.pending).toBe(1)

      await mesh.proxy.advance(500)
      expect(mesh.proxy.pending).toBe(0)
      expect(beats[0]?.deliveries[0]?.atMs).toBe(beats[1]?.deliveries[0]!.atMs + 500)
      // NON-VACUITY: the lease, sent under an empty script, was delivered at the
      // instant it was sent rather than 500ms afterwards.
      const lease = mesh.timeline().find((entry) => entry.recordType === "mesh.lease")
      expect(lease?.deliveries[0]?.atMs).toBe(lease?.sentAtMs)
    } finally {
      mesh.close()
    }
  })

  it("a `partition` cuts one DIRECTED link, and healing it restores exactly that link", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const heartbeat = heartbeatEnvelope({ nodeId: mesh.workerNodeId, sequence: 1, observedAtMs: mesh.clock.now() })
      mesh.partition({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      expect(mesh.proxy.isPartitioned({ from: mesh.workerNodeId, to: mesh.controllerNodeId })).toBe(true)
      expect(mesh.proxy.isPartitioned({ from: mesh.controllerNodeId, to: mesh.workerNodeId })).toBe(false)

      const refused = await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: heartbeat }).then(() => undefined, (error: unknown) => error)
      expect(faultCode(refused)).toBe("fault.partitioned")
      const cut = transmissionOf(mesh, "mesh.heartbeat")
      expect(cut.partitionActive).toBe(true)
      expect(cut.deliveries).toEqual([{ copy: 1, atMs: cut.sentAtMs, outcome: "partitioned" }])
      expect(mesh.proxy.pending).toBe(0)
      // The controller never saw it: a cut link is not a queue.
      const before = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(before.ok && before.value?.liveness).toBe("never-seen")

      // NON-VACUITY: the reverse direction was never cut, and the same record on
      // the healed link is accepted and advertised.
      mesh.heal({ from: mesh.workerNodeId, to: mesh.controllerNodeId })
      expect(mesh.proxy.isPartitioned({ from: mesh.workerNodeId, to: mesh.controllerNodeId })).toBe(false)
      const delivered = await mesh.worker.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: heartbeat })
      expect((delivered as { result?: { outcome?: string } }).result?.outcome).toBe("accepted")
      const advertised = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(advertised.ok && advertised.value?.liveness).toBe("live")
      // NON-VACUITY: the cut delivery left the controller at `never-seen` two
      // lines above, so the advertisement is a consequence of the heal.
      expect((advertised.ok ? advertised.value?.lastHeartbeatAt : null) !== null).toBe(true)
    } finally {
      mesh.close()
    }
  })

  it("refuses a record that names no family it can read, and one addressed to a node it does not hold", async () => {
    const clock = new ScriptedClock(FAULT_T0_MS)
    const node = nodeIdSchema.parse("node-fault-unregistered")
    const identity = aNodeIdentity(node, clock, FAULT_MESH_ID)
    const proxy = new MeshFaultProxy(clock, NO_FAULTS)
    const sign = (record: unknown): MeshRequestSignature => identity.sign("POST", "/v1/mesh/event", record, clock.now())

    await expect(
      proxy.send({
        from: node,
        to: node,
        record: { nothing: true },
        signature: sign({ nothing: true }),
        resign: () => sign({ nothing: true }),
        method: "POST",
        path: "/v1/mesh/event",
      }),
    ).rejects.toMatchObject({ code: "fault.unnamed_record", retryable: true })
    // A record the proxy refused was never given a sequence, so a scenario
    // reading the timeline by index still sees only what actually moved.
    expect(proxy.timeline()).toHaveLength(0)
    expect(proxy.pending).toBe(0)

    const record = heartbeatEnvelope({ nodeId: node, sequence: 1, observedAtMs: FAULT_T0_MS })
    await expect(
      proxy.send({
        from: node,
        // A destination the proxy has no endpoint for, which is the fifth
        // transport refusal and the only one it answers from its own routing
        // table rather than from the record or the link.
        to: nodeIdSchema.parse("node-fault-nowhere"),
        record,
        signature: sign(record),
        resign: () => sign(record),
        method: "POST",
        path: "/v1/mesh/heartbeat",
      }),
    ).rejects.toMatchObject({ code: "fault.unknown_destination", retryable: true })
  })

  it("a node's process being down refuses the send and only a restart can clear it", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const record = scenario.executeRecord(1)
      mesh.killNode(mesh.workerNodeId)
      expect(mesh.proxy.isDown(mesh.workerNodeId)).toBe(true)

      const refused = await mesh.controller
        .send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
        .then(() => undefined, (error: unknown) => error)
      expect(faultCode(refused)).toBe("fault.node_down")
      expect(await inboxRowCount(mesh)).toBe(0)
      const dead = transmissionOf(mesh, "mesh.command")
      expect(dead.deliveries).toEqual([{ copy: 1, atMs: dead.sentAtMs, outcome: "node_down" }])
      expect(mesh.proxy.pending).toBe(0)

      // NON-VACUITY: the same command on the same node, after the restart. Nothing
      // about the command changed — only whether a process was listening.
      await mesh.restartNode(mesh.workerNodeId)
      expect(mesh.proxy.isDown(mesh.workerNodeId)).toBe(false)
      const accepted = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("is a TRANSPORT seam: it holds one inbound handler per node and nothing that could reach a store", async () => {
    const clock = new ScriptedClock(FAULT_T0_MS)
    // A proxy with a bare function registered moves records. There is no node
    // here, no database and no seam to reach for, so every delivery this
    // produces was produced by the proxy alone.
    const seen: string[] = []
    const proxy = new MeshFaultProxy(clock, NO_FAULTS)
    const node: NodeId = nodeIdSchema.parse("node-fault-bare")
    proxy.register(node, async (request) => {
      seen.push(String((request.record as { recordType: string }).recordType))
      return { result: { outcome: "accepted" } }
    })

    const record = heartbeatEnvelope({ nodeId: node, sequence: 1, observedAtMs: FAULT_T0_MS })
    const signature = { nodeId: node } as unknown as MeshRequestSignature
    const response = await proxy.send({ from: node, to: node, record, signature, resign: () => signature, method: "POST", path: "/v1/mesh/heartbeat" })

    expect(seen).toEqual(["mesh.heartbeat"])
    expect(response).toEqual({ result: { outcome: "accepted" } })
    expect(proxy.pending).toBe(0)
    expect(proxy.timeline()).toHaveLength(1)
  })
})

/** The nth transmission of `recordType`, 1-based, from the proxy's own timeline. */
function transmissionOf(mesh: { readonly timeline: () => readonly TransmissionRecord[] }, recordType: string, nth = 1): TransmissionRecord {
  const matching = mesh
    .timeline()
    .filter((entry) => entry.recordType === recordType)
  const found = matching[nth - 1]
  if (found === undefined) throw new Error(`the fault timeline holds no ${recordType} transmission #${nth}; it holds ${matching.length}`)
  return found
}

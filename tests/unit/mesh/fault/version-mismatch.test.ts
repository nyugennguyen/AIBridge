/**
 * M4-V, at the wire: a record at an unknown version is refused, never coerced.
 *
 * The property is the NEGATIVE one — "not coerced" — so the assertions are the
 * awkward ones: that the row count did not move, that no field of the tampered
 * record was believed, and that the untampered record built from the same
 * builder is admitted immediately afterwards. A suite that only checked the
 * refusal would pass against a node that refuses everything.
 */
import { describe, expect, it } from "vitest"
import { CURRENT_SCHEMA_VERSION, SCHEMA_VERSIONS } from "../../../../src/orchestration/identifiers.js"
import { inboxOutcomeOf, leaseOutcomeOf } from "../../../../src/mesh/fault/harness.js"
import { heartbeatEnvelope, leaseEnvelope } from "../../../../src/mesh/fault/records.js"
import { anApprovedScenario, inboxRowCount } from "./fixtures.js"

function refusalOf(response: unknown): { code: string; category: string; message: string; retryable: boolean } {
  const outcome = inboxOutcomeOf(response)
  if (outcome?.outcome !== "refused") throw new Error(`expected a refusal, got '${String(outcome?.outcome)}'`)
  return outcome.error
}

describe("version mismatch", () => {
  it("refuses a `mesh.command` at an unsupported version, and admits the same command at the supported one", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const rowsBefore = await inboxRowCount(mesh)
      const supported = scenario.executeRecord(1)
      const versioned = supported as unknown as Record<string, unknown>
      const payload = supported.payload as Record<string, unknown>

      const cases: readonly { readonly name: string; readonly record: Record<string, unknown>; readonly code: string }[] = [
        {
          name: "an unsupported version on the envelope",
          record: { ...versioned, schemaVersion: 99 },
          code: "protocol.unsupported_schema_version",
        },
        {
          // A version this BUILD supports, but which this FAMILY never declared.
          // The two refusals are the same code and the two causes are different
          // operator actions, so a mesh that could only produce the first would
          // send an operator to reinstall a node whose problem is its peer.
          name: "a version this build supports but the family never declared",
          record: { ...versioned, schemaVersion: SCHEMA_VERSIONS[0] },
          code: "protocol.unsupported_schema_version",
        },
        {
          name: "no version at all",
          record: Object.fromEntries(Object.entries(versioned).filter(([key]) => key !== "schemaVersion")),
          code: "protocol.unversioned_record",
        },
        {
          name: "an unsupported version inside the payload",
          record: { ...versioned, payload: { ...payload, schemaVersion: 99 } },
          code: "protocol.record_invalid",
        },
      ]

      for (const testCase of cases) {
        const response = await mesh.controller.send({
          from: mesh.controllerNodeId,
          to: mesh.workerNodeId,
          record: testCase.record,
        })
        const error = refusalOf(response)
        expect([testCase.name, error.code]).toEqual([testCase.name, testCase.code])
        // NOT RETRYABLE, and that is the operational half of the rule: a
        // version-skewed peer will never parse on this build however long the
        // sender retries, so a retryable refusal is a loop that cannot end.
        expect([testCase.name, error.retryable]).toEqual([testCase.name, false])
        // NOTHING was written, and nothing was partially read: a coerced record
        // would leave a row with some of its fields believed.
        expect([testCase.name, await inboxRowCount(mesh)]).toEqual([testCase.name, rowsBefore])
      }

      // The unsupported-version refusal NAMES the versions this build speaks,
      // because the operator's next action is an upgrade and the message is the
      // only place that fact appears.
      const unsupported = refusalOf(
        await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: { ...versioned, schemaVersion: 99 } }),
      )
      expect(unsupported.category).toBe("validation")
      expect(unsupported.message).toContain(`schemaVersion 99`)
      expect(unsupported.message).toContain(`[${SCHEMA_VERSIONS.join(", ")}]`)
      expect(unsupported.message).toContain("refused rather than coerced")

      // NON-VACUITY: the untampered record built by the same builder, on the
      // same mesh, is admitted. Everything above is the tamper and nothing else.
      expect(versioned.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
      const accepted = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: supported })
      expect(inboxOutcomeOf(accepted)?.outcome).toBe("accepted")
      expect(await inboxRowCount(mesh)).toBe(rowsBefore + 1)
      expect(mesh.worker.runtime().executions).toEqual([])
    } finally {
      mesh.close()
    }
  })

  it("refuses a `mesh.lease` at an unsupported version and leaves the lease in force untouched", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const before = await mesh.worker.heldLease()
      expect(before?.epoch).toBe(1)
      const rowsBefore = await inboxRowCount(mesh)

      const renewal = leaseEnvelope({
        leaseId: "lease-run-fault-1-e1",
        controllerNodeId: mesh.controllerNodeId,
        recipientNodeId: mesh.workerNodeId,
        epoch: 1,
        operation: "renew",
        issuedAtMs: mesh.clock.now(),
        expiresAtMs: mesh.clock.now() + 30_000,
      })
      const response = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: { ...renewal, schemaVersion: 99 },
      })

      // The family is not the point: the VERSION is, and a mesh where only
      // `mesh.command` were version-checked would answer this one.
      const outcome = leaseOutcomeOf(response)
      expect(outcome?.outcome).toBe("refused")
      expect(outcome?.outcome === "refused" ? outcome.reason : "").toBe("record_unreadable")
      expect(outcome?.outcome === "refused" ? outcome.error.code : "").toBe("protocol.unsupported_schema_version")
      // The lease in force is unchanged and nothing was persisted.
      expect(await mesh.worker.heldLease()).toEqual(before)
      expect(await inboxRowCount(mesh)).toBe(rowsBefore)

      // NON-VACUITY: the same renewal at the supported version is applied, which
      // is what makes the refusal about the version rather than about a renewal
      // this node may not perform.
      const healed = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: { ...renewal, schemaVersion: CURRENT_SCHEMA_VERSION },
      })
      expect(leaseOutcomeOf(healed)?.outcome).toBe("accepted")
    } finally {
      mesh.close()
    }
  })

  it("a `mesh.heartbeat` at an unsupported version does not advertise the node", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const before = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(before.ok && before.value?.liveness).toBe("never-seen")

      const heartbeat = heartbeatEnvelope({ nodeId: mesh.workerNodeId, sequence: 1, observedAtMs: mesh.clock.now() })
      const refused = await mesh.controller.send({
        from: mesh.workerNodeId,
        to: mesh.controllerNodeId,
        record: { ...heartbeat, schemaVersion: 99 },
      })
      expect((refused as { result?: { outcome?: string } }).result?.outcome).toBe("refused")
      const stillUnknown = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(stillUnknown.ok && stillUnknown.value?.liveness).toBe("never-seen")

      // NON-VACUITY: the same heartbeat at the supported version advertises it.
      const accepted = await mesh.controller.send({ from: mesh.workerNodeId, to: mesh.controllerNodeId, record: heartbeat })
      expect((accepted as { result?: { outcome?: string } }).result?.outcome).toBe("accepted")
      const advertised = await mesh.controller.registry.node(mesh.workerNodeId)
      expect(advertised.ok && advertised.value?.liveness).toBe("live")
    } finally {
      mesh.close()
    }
  })

  it("a version is never coerced: the refused command is refused identically on every delivery", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh
    try {
      const tampered = { ...(scenario.executeRecord(1) as unknown as Record<string, unknown>), schemaVersion: 99 }
      const rowsBefore = await inboxRowCount(mesh)
      const codes = new Set<string>()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        codes.add(refusalOf(await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: tampered })).code)
      }
      // The same refusal, every time: a node that fell back to a default shape
      // on the third delivery would be a version-dependent behaviour, which is
      // the failure mode M4-V exists to make impossible.
      expect([...codes]).toEqual(["protocol.unsupported_schema_version"])
      expect(await inboxRowCount(mesh)).toBe(rowsBefore)
    } finally {
      mesh.close()
    }
  })
})

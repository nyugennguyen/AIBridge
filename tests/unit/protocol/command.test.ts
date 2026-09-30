import { describe, expect, it } from "vitest"
import { digestJson } from "../../../src/orchestration/digest.js"
import { COMMAND_MATRIX } from "../../../src/orchestration/invariants.js"
import { fingerprintCommand } from "../../../src/orchestration/event-store/fingerprint.js"
import {
  checkIncomingCommand,
  dispatchIdOf,
  mintMeshCommand,
  verifyIncomingCommand,
  type IncomingCommandExpectation,
  type MeshCommand,
} from "../../../src/mesh/protocol/command.js"
import { ackForReceipt, decideCommandReceipt, meshAckSchema, type StoredCommandReceipt } from "../../../src/mesh/protocol/ack.js"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import { MAX_COMMAND_PAYLOAD_BYTES } from "../../../src/mesh/protocol/bounds.js"
import {
  CONTROLLER_ID,
  EPOCH,
  LEASE_ID,
  OTHER_WORKER_ID,
  PROJECT_ID,
  RUN_ID,
  T1,
  T2,
  WORKER_ID,
  at,
  makeApproval,
  makeCommand,
  makeDispatch,
  makeRunCreateCommand,
  rawEnvelope,
  sampleEnvelope,
} from "./fixtures.js"

/**
 * §4.4 of the spec, and scenario 1 (retry) and scenario 4 (stale epoch) of the
 * diagrams.
 *
 * `mesh.command` is the family where the difference between a CLAIM and a GRANT
 * is most tempting, because the command payload contains an approval, a dispatch
 * and a lease, and each of those LOOKS like permission. `verifyIncomingCommand`
 * therefore returns them as `authorizationClaims` and resolves nothing: the grant
 * is whatever the event log recorded, and M4.4's command seam is the thing that
 * reads the log. The tests below assert that boundary from both sides — the
 * claims are present and self-consistent, and no verdict field anywhere says
 * "authorized".
 */

const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")
const MID_WINDOW_MS = T0_MS + 5_000

function expectation(overrides: Partial<IncomingCommandExpectation> = {}): IncomingCommandExpectation {
  return {
    recipientNodeId: WORKER_ID as never,
    controllerNodeId: CONTROLLER_ID as never,
    projectId: PROJECT_ID as never,
    runId: RUN_ID as never,
    acceptedEpoch: EPOCH as never,
    nowMs: MID_WINDOW_MS,
    ...overrides,
  }
}

function wire(command = makeCommand(), targetNodeId: string = WORKER_ID): MeshCommand {
  return mintMeshCommand({ command, targetNodeId: targetNodeId as never })
}

function commandEnvelope(command: Parameters<typeof mintMeshCommand>[0]["command"]): Record<string, unknown> {
  return rawEnvelope("mesh.command", mintMeshCommand({ command, targetNodeId: WORKER_ID as never }), {
    correlationId: command.commandId,
  })
}

describe("minting a command", () => {
  it("digests the canonical payload and stamps the mesh protocol version", () => {
    const record = wire()
    expect(record.payloadDigest).toBe(digestJson(record.command))
    expect(record.meshProtocolVersion).toBe(1)
    expect(record.commandType).toBe("run.pause")
  })

  it("refuses to mint a record that would fail its own digest check", () => {
    // A hand-built record with a stale digest is a record that could be
    // persisted before verification. The minting seam exists so that is not
    // expressible from the producing side.
    const tampered = { ...wire(), payloadDigest: digestJson({ not: "the command" }) }
    const verified = verifyIncomingCommand(tampered, expectation())
    expect(verified.ok).toBe(false)
    expect(verified.ok === false && verified.reason).toBe("payload_digest_mismatch")
  })

  it("binds the wire scope to the command's own scope on every overlapping field", () => {
    const envelope = sampleEnvelope("mesh.command")
    expect(safeParseMeshEnvelope(envelope).ok).toBe(true)

    const cases: readonly [string, Record<string, unknown>][] = [
      ["projectId", { projectId: "project-other" }],
      ["runId", { runId: "run-other" }],
      ["commandId", { commandId: "cmd-8" }],
      ["controllerNodeId", { controllerNodeId: OTHER_WORKER_ID }],
      ["controllerEpoch", { controllerEpoch: 9 }],
      ["leaseId", { leaseId: "lease-other" }],
      ["issuedAt", { issuedAt: T1 }],
      ["expiresAt", { expiresAt: at(40) }],
    ]
    for (const [field, override] of cases) {
      const broken = { ...sampleEnvelope("mesh.command"), payload: { ...(sampleEnvelope("mesh.command").payload as object), ...override } }
      const safe = safeParseMeshEnvelope(broken)
      expect(safe.ok, `payload.${field}`).toBe(false)
    }
  })

  it("refuses a command type with no COMMAND_MATRIX row and a type that contradicts the payload", () => {
    // This is a TYPE-level check, not the matrix gate. The gate — is this
    // command allowed in the states it will act in — is M4.4's, resolved against
    // RECORDED state. What the wire can do is refuse to carry a command that no
    // matrix row could ever license.
    const payload = sampleEnvelope("mesh.command").payload as Record<string, unknown>
    const unlicensed = { ...payload, commandType: "run.teleport" }
    const safe = safeParseMeshEnvelope({ ...sampleEnvelope("mesh.command"), payload: unlicensed })
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain("COMMAND_MATRIX")

    const lying = { ...payload, commandType: "run.resume" }
    expect(safeParseMeshEnvelope({ ...sampleEnvelope("mesh.command"), payload: lying }).ok).toBe(false)
  })

  it("names the dispatch a command acts on, and none for a run-scoped command", () => {
    expect(dispatchIdOf(makeCommand())).toBeNull()
    expect(dispatchIdOf(makeCommand({ type: "dispatch.propose" }))).toBe("dispatch-1")
    expect(dispatchIdOf(makeCommand({ type: "dispatch.timeout.request", payload: { dispatchId: "dispatch-9", reason: "x" } }))).toBe(
      "dispatch-9",
    )
    const scoped = wire(makeCommand({ type: "dispatch.propose" }))
    expect(scoped.dispatchId).toBe("dispatch-1")
    // A run-scoped command carries `null` rather than omitting the field, so
    // "not about a dispatch" and "about a dispatch I forgot to name" differ.
    expect(wire().dispatchId).toBeNull()
  })

  it("refuses a dispatch scope on the wire that the payload does not act on", () => {
    const payload = sampleEnvelope("mesh.command").payload as Record<string, unknown>
    expect(safeParseMeshEnvelope({ ...sampleEnvelope("mesh.command"), payload: { ...payload, dispatchId: "dispatch-1" } }).ok).toBe(
      false,
    )
  })
})

describe("verifyIncomingCommand — integrity and scope", () => {
  it("accepts an intact, addressed, in-epoch command", () => {
    const verified = verifyIncomingCommand(wire(), expectation())
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.value.commandId).toBe("cmd-7")
    expect(verified.value.payloadDigest).toBe(verified.value.recomputedDigest)
    expect(verified.value.projectId).toBe(PROJECT_ID)
    expect(verified.value.runId).toBe(RUN_ID)
    expect(verified.value.controllerEpoch).toBe(EPOCH)
  })

  it("refuses a tampered payload with protocol.payload_digest_mismatch", () => {
    const record = wire()
    // DELIBERATE INVALID RECORD. The cast is the point of the test: the payload
    // is replaced with one whose `type` no longer agrees with its `payload`, which
    // no `OrchestrationCommand` can be, and the whole question is whether
    // `verifyIncomingCommand` reports the DIGEST before it reports the shape. A
    // record that only violated its schema would prove nothing about ordering.
    const tampered = {
      ...record,
      command: { ...record.command, payload: { reason: "something else entirely" } },
    } as unknown as MeshCommand
    const verified = verifyIncomingCommand(tampered, expectation())
    expect(verified.ok).toBe(false)
    expect(verified.ok === false && verified.reason).toBe("payload_digest_mismatch")
    expect(verified.ok === false && verified.error.code).toBe("protocol.payload_digest_mismatch")
    // NOT persisted, and the message says so, because "we refused it" and "we
    // logged it and will re-check later" are different remediations.
    expect(verified.ok === false && verified.error.message).toContain("MUST NOT be persisted")
    expect(verified.ok === false && verified.error.retryable).toBe(false)
  })

  it("refuses a command addressed to another node, or from another controller", () => {
    for (const [record, expected, reason, code] of [
      [wire(makeCommand(), OTHER_WORKER_ID), expectation(), "recipient_mismatch", "protocol.command_not_addressed_here"],
      [wire(), expectation({ controllerNodeId: OTHER_WORKER_ID as never }), "controller_mismatch", "protocol.command_from_unknown_controller"],
      [wire(), expectation({ projectId: "project-other" as never }), "project_mismatch", "protocol.command_project_scope_mismatch"],
      [wire(), expectation({ runId: "run-other" as never }), "run_mismatch", "protocol.command_run_scope_mismatch"],
    ] as const) {
      const verified = verifyIncomingCommand(record as MeshCommand, expected as IncomingCommandExpectation)
      expect(verified.ok, reason).toBe(false)
      expect(verified.ok === false && verified.reason).toBe(reason)
      expect(verified.ok === false && verified.error.code).toBe(code)
    }
  })

  it("reports time last, so a stale command with a bad clock is not read as a clock problem", () => {
    const record = wire(makeCommand({ issuedAt: "2026-09-28T00:00:00.000Z", expiresAt: T2 }))
    const stale = verifyIncomingCommand(record, expectation({ acceptedEpoch: 9 as never, nowMs: Date.parse(T2) + 1 }))
    expect(stale.ok === false && stale.reason).toBe("epoch_stale")
  })
})

describe("verifyIncomingCommand — authority", () => {
  it("refuses a LOWER epoch as stale and a HIGHER epoch as unregistered, and never queues either", () => {
    // Both are refusals and neither is "store it for later": a command minted
    // under a superseded controller was decided against a projection that no
    // longer exists, and a higher epoch is only ever accepted through the
    // explicit takeover flow.
    const stale = verifyIncomingCommand(wire(makeCommand({ controllerEpoch: 3 })), expectation({ acceptedEpoch: 4 as never }))
    expect(stale.ok === false && stale.reason).toBe("epoch_stale")
    expect(stale.ok === false && stale.error.code).toBe("epoch.stale")
    expect(stale.ok === false && stale.error.category).toBe("stale_epoch")
    expect(stale.ok === false && stale.error.message).toContain("NOT queued")

    const unregistered = verifyIncomingCommand(wire(makeCommand({ controllerEpoch: 5 })), expectation({ acceptedEpoch: 4 as never }))
    expect(unregistered.ok === false && unregistered.reason).toBe("epoch_unregistered")
    expect(unregistered.ok === false && unregistered.error.code).toBe("epoch.unregistered")
    expect(unregistered.ok === false && unregistered.error.message).toContain("takeover")
  })

  it("refuses a record whose wire epoch and payload epoch disagree", () => {
    const record = wire()
    const inconsistent = { ...record, controllerEpoch: 6 } as MeshCommand
    const verified = verifyIncomingCommand(inconsistent, expectation())
    expect(verified.ok === false && verified.reason).toBe("epoch_not_self_consistent")
  })

  it("refuses a dispatch scope the payload does not act on", () => {
    const record = wire()
    const mismatched = { ...record, dispatchId: "dispatch-3" as never } as MeshCommand
    const verified = verifyIncomingCommand(mismatched, expectation())
    expect(verified.ok === false && verified.reason).toBe("dispatch_scope_mismatch")
  })

  it("surfaces the payload's authorization fields as CLAIMS and never as a verdict", () => {
    // A `dispatch.execute` carries an approval id. The wire layer can check that
    // the id is present and bound to the dispatch; it CANNOT check that the
    // recorded log granted it, and the shape of the return value says so.
    const approval = makeApproval()
    const command = makeCommand({
      type: "dispatch.execute",
      payload: { dispatch: makeDispatch(), approval },
    })
    const verified = verifyIncomingCommand(wire(command), expectation())
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.value.authorizationClaims).toEqual({
      approvalId: "approval-1",
      dispatchId: "dispatch-1",
      leaseId: LEASE_ID,
      controllerEpoch: EPOCH,
    })

    const keys = Object.keys(verified.value)
    expect(keys).not.toContain("authorized")
    expect(keys).not.toContain("granted")
    expect(keys).not.toContain("approved")
    // Every field a later seam needs to resolve the claims against the log.
    expect(keys).toEqual(expect.arrayContaining(["command", "commandId", "payloadDigest", "recomputedDigest"]))
  })

  it("reports no approval claim for a command that has none", () => {
    const verified = verifyIncomingCommand(wire(), expectation())
    expect(verified.ok && verified.value.authorizationClaims.approvalId).toBeNull()
  })
})

describe("verifyIncomingCommand — replay window", () => {
  it("refuses an expired command and one issued beyond the skew allowance", () => {
    const record = wire(makeCommand({ issuedAt: "2026-09-28T00:00:00.000Z", expiresAt: T2 }))
    const expired = verifyIncomingCommand(record, expectation({ nowMs: Date.parse(T2) + 1 }))
    expect(expired.ok === false && expired.reason).toBe("expired")
    expect(expired.ok === false && expired.error.code).toBe("protocol.record_expired")

    const early = verifyIncomingCommand(record, expectation({ nowMs: T0_MS - 300_001 }))
    expect(early.ok === false && early.reason).toBe("not_yet_valid")
  })

  it("flavours the same refusals through the Result seam", () => {
    const refused = checkIncomingCommand(wire(), expectation({ acceptedEpoch: 9 as never }))
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error.code).toBe("epoch.stale")
    expect(checkIncomingCommand(wire(), expectation()).ok).toBe(true)
  })
})

describe("retry convergence — the same command five times", () => {
  /**
   * The convergence assertion from scenario 1, expressed as an inbox the test
   * owns. A `Map` keyed by `commandId` is the whole of M4.5's storage contract
   * for the property under test: ONE row per id, and the stored result returned
   * unchanged for every repeat.
   *
   * Every attempt RE-MINTS with a fresh clock window, which is what a controller
   * that never heard the ack actually does. That is not decoration: the wire
   * `payloadDigest` covers `issuedAt` and `expiresAt`, so all five records carry
   * five DIFFERENT wire digests for one instruction. A dedupe keyed on the wire
   * digest fails this test on attempt two with a conflict — which is the defect
   * B8 from the Milestone 3 plan, reproduced one layer up, and the reason the
   * comparison is on the semantic fingerprint.
   */
  it("persists one row, runs one session, and returns the stored result every time", () => {
    const inbox = new Map<string, StoredCommandReceipt<{ readonly attempt: number }>>()
    const sessions: string[] = []
    const responses: unknown[] = []
    const wireDigests = new Set<string>()

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const record = wire(makeCommand({ issuedAt: at(1), expiresAt: at(10 + attempt) }))
      wireDigests.add(record.payloadDigest)
      const verified = verifyIncomingCommand(record, expectation())
      expect(verified.ok, `attempt ${attempt}`).toBe(true)
      if (!verified.ok) continue

      const stored = inbox.get(record.commandId) ?? null
      const receipt = decideCommandReceipt(record, stored)
      if (receipt.disposition === "apply") {
        const sessionId = `session-for-${record.commandId}`
        sessions.push(sessionId)
        const result = { sessionId, attempt }
        inbox.set(record.commandId, {
          row: { attempt },
          semanticFingerprint: fingerprintCommand(record.command).semantic,
          storedResult: result,
        })
        responses.push(result)
      } else if (receipt.disposition === "return_stored") {
        responses.push(receipt.storedResult)
      } else {
        throw new Error(`unexpected conflict on an identical retry: ${receipt.reason}`)
      }
    }

    // Non-vacuity for the fix: the five arrivals really were five different wire
    // records. A test in which they all digest identically would also pass against
    // the wire-digest comparison, and would prove nothing.
    expect(wireDigests.size).toBe(5)
    expect(inbox.size).toBe(1)
    expect(sessions).toEqual([`session-for-cmd-7`])
    expect(responses).toHaveLength(5)
    // Responses 2-5 equal response 1, field for field. "Equal" is asserted over
    // the whole object rather than by id so a handler that re-derives a fresh
    // result per retry — with a new session id, a new timestamp — fails here.
    for (const response of responses.slice(1)) expect(response).toEqual(responses[0])
  })

  it("does not recreate the outbox row for the effect on a duplicate", () => {
    // The diagram's last line: the controller's outbox row is still `pending`
    // until the ack, and a `duplicate` ack retires it without the worker having
    // produced a new event to send.
    const record = wire()
    const first = decideCommandReceipt(record, null)
    expect(first.disposition).toBe("apply")
    const stored = storedFor(record, { sessionId: "session-1" })
    const second = decideCommandReceipt(record, stored)
    expect(second.disposition).toBe("return_stored")
    expect(second.duplicate).toBe(true)
    const ack = ackForReceipt(record, second, T1 as never)
    expect(ack.outcome).toBe("duplicate")
    expect(ack.acksCommandId).toBe("cmd-7")
    expect(ack.rejectionCode).toBeUndefined()
  })

  it("treats the same id with a DIFFERENT INSTRUCTION as a conflict that writes nothing", () => {
    // The forged case, restated correctly. A record whose `payloadDigest` field
    // was edited is a record the INTEGRITY step refuses, and it never reaches a
    // dedupe decision at all — so asserting a conflict there was asserting a
    // guard one layer up. The real conflict is a different payload under a reused
    // id, which changes the semantic fingerprint and therefore still conflicts.
    const first = wire()
    const stored = storedFor(first, { sessionId: "session-1" })
    const mutated = wire(makeCommand({ payload: { reason: "do something else entirely" } }))
    expect(mutated.payloadDigest).not.toBe(first.payloadDigest)
    const receipt = decideCommandReceipt(mutated, stored)
    expect(receipt.disposition).toBe("conflict")
    expect(receipt.duplicate).toBe(true)
    // A conflict acks as REJECTED, not `duplicate`. They look alike and are
    // opposites: `duplicate` lets the sender retire its row, while a conflict
    // must leave that row visible for an operator.
    const ack = ackForReceipt(mutated, receipt, T1 as never)
    expect(ack.outcome).toBe("rejected")
    expect(ack.rejectionCode).toBe("duplicate_conflict")
    expect(meshAckSchema.safeParse(ack).success).toBe(true)
  })
})

/**
 * A stored receipt for `record`, keyed the way the store keys it.
 *
 * The fingerprint is the record's own SEMANTIC one, so a fixture that hands
 * `decideCommandReceipt` the wrong column cannot accidentally make a test pass:
 * the wire digest is deliberately not offered here.
 */
function storedFor(record: MeshCommand, storedResult: unknown): StoredCommandReceipt<{ readonly acceptedSequence: number }> {
  return {
    row: { acceptedSequence: 1 },
    semanticFingerprint: fingerprintCommand(record.command).semantic,
    storedResult,
  }
}

describe("command payload bound", () => {
  it("refuses a command payload over MAX_COMMAND_PAYLOAD_BYTES on the producing side", () => {
    // Two 64 KiB task descriptions: 132 131 canonical bytes against a 131 072
    // bound. The KERNEL accepts this command, so what refuses it is the mesh
    // bound and not the shape saying the same thing twice. The bound is applied
    // at MINTING, which means a caller cannot put such a record into its outbox
    // in the first place.
    const oversized = makeRunCreateCommand(2, 65_536)
    expect(() => mintMeshCommand({ command: oversized, targetNodeId: WORKER_ID as never })).toThrow(/131072 byte bound/)
  })

  it("refuses an oversized command on the receiving side too", () => {
    // Minting is not the only door: a peer builds its own bytes, so the
    // receiving schema has to carry the bound as well.
    const oversized = makeRunCreateCommand(2, 65_536)
    const record = {
      ...commandEnvelope(makeRunCreateCommand(1, 64)),
      // The receiver's copy of the record is assembled by hand, which is the
      // situation the bound exists for; `payload` is `unknown` on a raw envelope
      // so it is narrowed here rather than at the builder.
      payload: { ...(sampleEnvelope("mesh.command").payload as object), command: oversized },
    }
    const safe = safeParseMeshEnvelope(record)
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain(String(MAX_COMMAND_PAYLOAD_BYTES))

    expect(safeParseMeshEnvelope(commandEnvelope(makeRunCreateCommand(1, 64))).ok).toBe(true)
    expect(MAX_COMMAND_PAYLOAD_BYTES).toBe(131_072)
  })
})

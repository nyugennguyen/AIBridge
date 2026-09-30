import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fingerprintCommand, NON_SEMANTIC_COMMAND_FIELDS } from "../../../../src/orchestration/event-store/fingerprint.js"
import { canonicalJson } from "../../../../src/orchestration/digest.js"
import { verifyIncomingCommand, type MeshCommand } from "../../../../src/mesh/protocol/command.js"
import { safeParseMeshEnvelope } from "../../../../src/mesh/protocol/registry.js"
import { decideCommandReceipt } from "../../../../src/mesh/protocol/ack.js"
import { storedResultOf } from "../../../../src/mesh/inbox/inbox.js"
import {
  TestClock,
  durableInboxHarness,
  executeCommand,
  licensingLog,
  memoryInboxHarness,
  at,
  iso,
  type InboxHarness,
} from "./fixtures.js"

/**
 * Semantic dedupe. The plan's Commands requirements and the retry diagram's
 * convergence test.
 *
 * Three claims are under test and the third is the one that actually catches the
 * defect this directory exists to prevent:
 *
 *   1. **Same commandId + identical instruction → the STORED result, and nothing
 *       appended.** Not a second row, and not this arrival's own result.
 *   2. **Same commandId + different instruction → `conflict.command_digest_conflict`,
 *       with nothing written.** Not a second row, and not the original row
 *       mutated.
 *   3. **A legitimate at-least-once retry is a DUPLICATE, not a conflict** — even
 *       though its wire `payloadDigest` differs, because the controller re-minted
 *       it and `issuedAt`/`expiresAt` moved.
 *
 * Claim 3 is the load-bearing one. The wire digest covers `issuedAt` and
 * `expiresAt`, so a retry of an unanswered command legitimately produces a
 * DIFFERENT wire digest for the SAME instruction. A dedupe keyed on the wire
 * digest answers every retry with a conflict, which is defect B8 from the
 * Milestone 3 plan — "duplicate commands cannot launch duplicate sessions or
 * submit duplicate prompts" — reproduced one layer up, and it does so as an
 * operator-visible failure on the normal path rather than only under load.
 *
 * The file reads the source and asserts the fingerprinting, because a comment
 * saying the right thing and code doing the wrong thing is the whole failure
 * mode here. `NON_SEMANTIC_COMMAND_FIELDS` is the kernel's own list, so the
 * assertion is against the kernel rather than against a copy in a test.
 */

const INBOX_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/inbox/inbox.ts"), "utf8")
const PROTOCOL_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/protocol/ack.ts"), "utf8")

describe("M4.5 dedupe is keyed on the SEMANTIC fingerprint, never the wire digest", () => {
  it("excludes exactly the kernel's transport fields", () => {
    expect(NON_SEMANTIC_COMMAND_FIELDS).toEqual(["commandId", "issuedAt", "expiresAt"])
  })

  it("does not compare the wire digest in the dedupe path", () => {
    // The bug this guards is a ONE-LINE substitution — `recomputedDigest` where
    // the semantic fingerprint belongs — that typechecks, reads correctly, and
    // turns every retry into a conflict. A structural assertion is the only thing
    // standing between that substitution and a green suite, and it is asserted on
    // the PROTOCOL module as well as the inbox because the decision lives there:
    // `decideCommandReceipt` is the one implementation, and both would have to be
    // wrong in the same way to let the substitution through.
    expect(PROTOCOL_SOURCE).toMatch(/fingerprintCommand\(incoming\.command\)\.semantic/)
    expect(PROTOCOL_SOURCE).not.toMatch(/incoming\.payloadDigest/)
    expect(INBOX_SOURCE).not.toMatch(/decideCommandReceipt\([^)]*recomputedDigest/)
    expect(INBOX_SOURCE).toMatch(/const semanticFingerprint = fingerprintCommand\(verified\.command\)\.semantic/)
  })

  it("keeps ONE implementation of the dedupe decision", () => {
    // Two copies of a three-way decision is a second set of answers to "is this
    // the same instruction", and the copy nobody reads is the one that drifts.
    // M4.5 shipped one in the inbox and one in the protocol with DIFFERENT keys —
    // the wire digest in the protocol, which answers every legitimate retry with a
    // conflict — and the inbox's callers were the only reason nobody noticed.
    expect(INBOX_SOURCE).not.toMatch(/function decideDuplicate/)
    expect(PROTOCOL_SOURCE).toMatch(/export function decideCommandReceipt/)
    expect(INBOX_SOURCE).toMatch(/decideCommandReceipt\(/)
  })

  it("changes the fingerprint when the instruction changes, and not when only the window moves", () => {
    const original = payloadOf(executeCommand())
    const reissued = payloadOf(executeCommand({ issuedAt: iso(at(2)), expiresAt: iso(at(21)) }))
    const mutated = payloadOf(executeCommand({ prompt: "Do something else" }))

    const originalFingerprint = fingerprintCommand(original).semantic
    // A re-mint with a new window: the WIRE digest moves, the semantic one does not.
    expect(fingerprintCommand(reissued).semantic).toBe(originalFingerprint)
    expect(canonicalJson(reissued)).not.toBe(canonicalJson(original))
    // A different instruction under the same id: both move, so it still conflicts.
    expect(fingerprintCommand(mutated).semantic).not.toBe(originalFingerprint)
  })
})

describe("M4.5 same command, same instruction: the STORED result and nothing appended", () => {
  it("returns the stored result for a redelivery that re-minted the clock window", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        const first = await harness.inbox.submit(executeCommand({ issuedAt: iso(at(1)), expiresAt: iso(at(20)) }))
        expect(first.outcome, label).toBe("accepted")
        if (first.outcome !== "accepted") continue
        await harness.inbox.recordResult(first.commandId, { sessionId: "sess-1" })

        // The controller never heard the ack, so it re-mints with a fresh window.
        // Same commandId, same instruction, DIFFERENT wire digest.
        harness.clock.set(at(5))
        const retry = await harness.inbox.submit(executeCommand({ issuedAt: iso(at(4)), expiresAt: iso(at(24)) }))

        expect(retry.outcome, label).toBe("duplicate")
        if (retry.outcome !== "duplicate") continue
        // The STORED result, not a freshly computed one.
        expect(retry.storedResult, label).toEqual({ sessionId: "sess-1" })
        expect(retry.acceptedSequence, label).toBe(first.acceptedSequence)
        expect(retry.ack.outcome, label).toBe("duplicate")

        // Exactly one row, and the ORIGINAL one — no append, no replace.
        const rows = await harness.rows()
        expect(rows, label).toHaveLength(1)
        expect(rows[0]?.commandId, label).toBe(first.commandId)
        expect(rows[0]?.acceptedAt, label).toBe(first.row.acceptedAt)
      } finally {
        harness.close()
      }
    }
  })

  it("converges on one row across five redeliveries, and every answer equals the first", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        const first = await harness.inbox.submit(executeCommand({ issuedAt: iso(at(1)), expiresAt: iso(at(20)) }))
        expect(first.outcome, label).toBe("accepted")
        if (first.outcome !== "accepted") continue
        await harness.inbox.recordResult(first.commandId, { sessionId: "sess-1" })

        const answers: unknown[] = []
        for (let attempt = 2; attempt <= 5; attempt += 1) {
          harness.clock.set(at(attempt))
          const again = await harness.inbox.submit(
            executeCommand({ issuedAt: iso(at(attempt)), expiresAt: iso(at(20 + attempt)) }),
          )
          expect(again.outcome, `${label} attempt ${attempt}`).toBe("duplicate")
          if (again.outcome === "duplicate") answers.push(again.storedResult)
        }

        expect(answers, label).toEqual([{ sessionId: "sess-1" }, { sessionId: "sess-1" }, { sessionId: "sess-1" }, { sessionId: "sess-1" }])
        expect(await harness.rows(), label).toHaveLength(1)
      } finally {
        harness.close()
      }
    }
  })

  it("answers a duplicate whose effect has not run yet, rather than refusing it", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        const retry = await harness.inbox.submit(executeCommand({ issuedAt: iso(at(3)), expiresAt: iso(at(23)) }))
        // Admitted, durable, the peer has not taken it. A refusal here would
        // strand the first command forever: the sender cannot tell "ran and
        // produced nothing" from "has not run yet", and treating the second as a
        // failure means the launch never happens.
        expect(retry.outcome, label).toBe("duplicate")
        if (retry.outcome !== "duplicate") continue
        expect(retry.storedResult, label).toBeNull()
        expect(retry.row.effectState, label).toBe("not_started")
      } finally {
        harness.close()
      }
    }
  })

  it("does not re-consult the recorded log for a duplicate", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        const readsAfterFirst = { ...harness.log.reads }
        await harness.inbox.submit(executeCommand({ issuedAt: iso(at(3)), expiresAt: iso(at(23)) }))
        // Re-authorizing a duplicate would consult a projection that has
        // legitimately moved on since the first delivery, turning a successful
        // retry into a spurious refusal. The counts are the observable proof.
        expect(harness.log.reads, label).toEqual(readsAfterFirst)
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 same commandId, different instruction: conflict, and NOTHING is written", () => {
  it("refuses a mutated payload under a reused id with nothing persisted", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        const first = await harness.inbox.submit(executeCommand())
        expect(first.outcome, label).toBe("accepted")
        if (first.outcome !== "accepted") continue
        const before = await harness.rows()

        const mutated = await harness.inbox.submit(executeCommand({ prompt: "Do something else entirely" }))
        expect(mutated.outcome, label).toBe("conflict")
        if (mutated.outcome !== "conflict") continue
        expect(mutated.error.code, label).toBe("conflict.command_digest_conflict")
        expect(mutated.ack.outcome, label).toBe("rejected")
        expect(mutated.ack.rejectionCode, label).toBe("duplicate_conflict")

        // The original row is BYTE-IDENTICAL. A conflict row would be a second
        // row for one command id, which is precisely what the primary key exists
        // to make impossible.
        const after = await harness.rows()
        expect(after, label).toHaveLength(before.length)
        expect(after[0], label).toEqual(before[0])
      } finally {
        harness.close()
      }
    }
  })

  it("does not overwrite the stored result of a conflicted command", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        const first = await harness.inbox.submit(executeCommand())
        if (first.outcome !== "accepted") throw new Error(`${label}: expected accept, got ${first.outcome}`)
        await harness.inbox.recordResult(first.commandId, { sessionId: "sess-original" })

        await harness.inbox.submit(executeCommand({ prompt: "Different work" }))
        const row = await harness.row(first.commandId)
        expect(storedResultOf(row!), label).toEqual({ sessionId: "sess-original" })
      } finally {
        harness.close()
      }
    }
  })

  it("treats a mutated approval pointer as a conflict, not a duplicate", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        // A different approvalId under the same commandId. The INSTRUCTION is
        // different even though the prompt is not: who authorised it is part of
        // the instruction, and it is inside the fingerprint because
        // `fingerprintCommand` covers the whole command minus three transport
        // fields.
        const mutated = await harness.inbox.submit(executeCommand({ approvalId: "approval-inbox-2" }))
        expect(mutated.outcome, label).toBe("conflict")
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 the ONE dedupe implementation is total over its three cases", () => {
  it("applies when nothing is stored", () => {
    expect(decideCommandReceipt(recordOf(), null).disposition).toBe("apply")
  })

  it("returns the stored row and result when the fingerprints match", () => {
    const record = recordOf(executeCommand())
    const decision = decideCommandReceipt(record, {
      row: { acceptedSequence: 1 },
      semanticFingerprint: fingerprintCommand(payloadOf(executeCommand())).semantic,
      storedResult: { sessionId: "sess-1" },
    })
    expect(decision.disposition).toBe("return_stored")
    if (decision.disposition !== "return_stored") return
    expect(decision.duplicate).toBe(true)
    expect(decision.row.acceptedSequence).toBe(1)
    expect(decision.storedResult).toEqual({ sessionId: "sess-1" })
  })

  it("answers a re-mint that refreshed only its clock window as a DUPLICATE", () => {
    // The case the wire-digest comparison got wrong, stated at the unit that owns
    // the decision. Same instruction, same command id, different `issuedAt` /
    // `expiresAt` — and a different WIRE digest, which is asserted so this cannot
    // quietly become a test of two identical records.
    const first = recordOf(executeCommand({ issuedAt: iso(at(1)), expiresAt: iso(at(20)) }))
    const remint = recordOf(executeCommand({ issuedAt: iso(at(9)), expiresAt: iso(at(28)) }))
    expect(remint.payloadDigest).not.toBe(first.payloadDigest)
    expect(fingerprintCommand(remint.command).semantic).toBe(fingerprintCommand(first.command).semantic)

    const decision = decideCommandReceipt(remint, {
      row: { acceptedSequence: 1 },
      semanticFingerprint: fingerprintCommand(first.command).semantic,
      storedResult: { sessionId: "sess-1" },
    })
    expect(decision.disposition).toBe("return_stored")
    if (decision.disposition === "return_stored") expect(decision.storedResult).toEqual({ sessionId: "sess-1" })
  })

  it("conflicts on a different instruction, and the reason names both fingerprints", () => {
    const stored = fingerprintCommand(payloadOf(executeCommand())).semantic
    const other = fingerprintCommand(payloadOf(executeCommand({ prompt: "Do something else" }))).semantic
    expect(other).not.toBe(stored)
    const decision = decideCommandReceipt(recordOf(executeCommand({ prompt: "Do something else" })), {
      row: { acceptedSequence: 1 },
      semanticFingerprint: stored,
      storedResult: null,
    })
    expect(decision.disposition).toBe("conflict")
    if (decision.disposition === "conflict") {
      expect(decision.duplicate).toBe(true)
      expect(decision.reason).toContain(stored)
      expect(decision.reason).toContain(other)
      // The reason says the two are not a retry, because "at-least-once
      // re-sends the SAME instruction" is the claim a reader has to be able to
      // check rather than take on trust.
      expect(decision.reason).toContain("at-least-once delivery re-sends the SAME instruction")
    }
  })
})

describe("M4.5 the stored wire digest is the SENDER'S, and it is not the dedupe key", () => {
  it("records the recomputed wire digest alongside the semantic fingerprint", async () => {
    for (const { label, make } of harnesses()) {
      const harness = make()
      try {
        const accepted = await harness.inbox.submit(executeCommand({ issuedAt: iso(at(1)), expiresAt: iso(at(20)) }))
        if (accepted.outcome !== "accepted") throw new Error(`${label}: expected accept, got ${accepted.outcome}`)
        const row = accepted.row

        // The two digests DIFFER on a fresh command, which is the fact that makes
        // conflating them a defect rather than a harmless duplication.
        expect(row.payloadDigest, label).not.toBe(row.semanticFingerprint)
        // And the stored wire digest is the one the receiver RECOMPUTED, not the
        // one the sender declared — the gate already refused a mismatch, so a
        // stored row carrying the sender's claim would be a second, unverified
        // copy of the same fact.
        const verified = verifyIncomingCommand(
          accepted.ack.acksCommandId === row.commandId
            ? (JSON.parse(row.commandJson) as never)
            : (JSON.parse(row.commandJson) as never),
          {
            recipientNodeId: row.targetNodeId,
            controllerNodeId: row.controllerNodeId,
            projectId: row.projectId,
            runId: row.runId,
            acceptedEpoch: row.controllerEpoch,
            nowMs: harness.clock.now(),
          },
        )
        expect(verified.ok, label).toBe(true)
        if (verified.ok) expect(verified.value.recomputedDigest, label).toBe(row.payloadDigest)
      } finally {
        harness.close()
      }
    }
  })
})

function payloadOf(envelope: Record<string, unknown>) {
  return (envelope.payload as { command: Parameters<typeof fingerprintCommand>[0] }).command
}

/**
 * The minted `MeshCommand` a fixture envelope carries, PARSED.
 *
 * `decideCommandReceipt` takes the wire record, so the unit tests that exercise it
 * directly need one in that shape. It goes through `safeParseMeshEnvelope` — the
 * protocol's one parse site — rather than a cast, because a cast would put the
 * type back without the check that the record is one a gateway could have
 * produced, and a dedupe test running against a hand-built object would prove
 * nothing about the record the wire actually carries.
 */
function recordOf(envelope: Record<string, unknown> = executeCommand()): MeshCommand {
  const parsed = safeParseMeshEnvelope(envelope)
  if (!parsed.ok) throw new Error(`fixture command did not parse: ${parsed.error.code}`)
  if (parsed.value.recordType !== "mesh.command") {
    throw new Error(`expected a mesh.command, got ${parsed.value.recordType}`)
  }
  return parsed.value.payload
}

/**
 * Both store implementations, each with a log that LICENSES the command.
 *
 * The licensing log is not incidental: a dedupe test run against a REFUSING log
 * would assert nothing, because every submission would stop at the authorization
 * step and no row would ever exist to be a duplicate of. Each harness gets its
 * own clock so a test that moves time in one does not silently move it in the
 * other.
 */
function harnesses(): { label: string; make: () => InboxHarness }[] {
  return [
    {
      label: "InMemoryCommandInboxStore",
      make: () => memoryInboxHarness(new TestClock(at(0)), { log: licensingLog(executeCommand()) }),
    },
    {
      label: "SqliteCommandInboxStore",
      make: () => durableInboxHarness(new TestClock(at(0)), { log: licensingLog(executeCommand()) }),
    },
  ]
}

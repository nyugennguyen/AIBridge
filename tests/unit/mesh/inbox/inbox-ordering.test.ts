import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { commandIdSchema, nodeIdSchema } from "../../../../src/orchestration/identifiers.js"
import {
  durableInboxHarness,
  executeCommand,
  licensingLog,
  memoryInboxHarness,
  pauseCommand,
  refusingGate,
  RecordingGate,
  TestClock,
  at,
  verifyingAdmission,
  type InboxHarness,
} from "./fixtures.js"

/**
 * The gate ORDER, and the two durability properties that depend on it.
 *
 * The plan's order is:
 *
 *   authenticate → `MeshCommandEpochGate.authorize` → digest/dedupe →
 *   recorded-log authorization → persist → ack
 *
 * and the sequence IS the deliverable of this seam, so it is asserted directly
 * rather than inferred from a set of properties that would each also hold under
 * some wrong ordering. Two of the six steps are individually untestable —
 * "authorization happened" and "authorization happened FIRST" are the same fact,
 * and only the order distinguishes them — so the trace is read as a sequence.
 *
 * The three durability claims, each of which fails under a different plausible
 * reorder:
 *
 *   - **Persisted before acknowledged.** Checked by reading the store from
 *     INSIDE the ack emitter, at the instant the ack is handed over. Checking
 *     after `submit` returns would pass under either order, because by then
 *     both have happened.
 *   - **Acks in accept order.** Checked with concurrent submissions, because a
 *     sequential test cannot distinguish "ordered" from "not contended".
 *   - **Authorization writes nothing.** Checked against the store, because a
 *     refusal that still wrote a row would make a later redelivery a duplicate
 *     of a command that was never authorized.
 */

const INBOX_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/inbox/inbox.ts"), "utf8")

const LABELS = ["InMemoryCommandInboxStore", "SqliteCommandInboxStore"] as const

function harnessWith(label: string, options: Parameters<typeof memoryInboxHarness>[1] = {}): InboxHarness {
  const clock = new TestClock(at(0))
  return label === "InMemoryCommandInboxStore"
    ? memoryInboxHarness(clock, options)
    : durableInboxHarness(clock, options)
}

function harnesses(options: Parameters<typeof memoryInboxHarness>[1] = {}): { label: string; make: () => InboxHarness }[] {
  return LABELS.map((label) => ({ label, make: () => harnessWith(label, options) }))
}

describe("M4.5 the gate order is authenticate → gate → dedupe → authorization → persist → ack", () => {
  it("runs the six steps in exactly that order for a first arrival", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        expect(harness.trace(), label).toEqual([
          "authenticate",
          "gate",
          "dedupe",
          "log.lease",
          "log.approval",
          "log.dispatch",
          "persist",
          "ack",
          "mark_ack",
        ])
      } finally {
        harness.close()
      }
    }
  })

  it("puts dedupe BEFORE recorded-log authorization", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        const trace = harness.trace()
        const dedupe = trace.indexOf("dedupe")
        const lease = trace.indexOf("log.lease")
        // A duplicate is not a new instruction. Re-authorizing one would consult
        // a projection that may legitimately have moved on since the first
        // delivery, which turns a successful retry into a spurious refusal.
        expect(dedupe, label).toBeGreaterThan(-1)
        expect(lease, label).toBeGreaterThan(dedupe)
      } finally {
        harness.close()
      }
    }
  })

  it("puts authentication BEFORE the gate, so a revoked node is not answered by a schema check", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()), authenticated: null })) {
      const harness = make()
      try {
        const outcome = await harness.inbox.submit(executeCommand())
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") {
          expect(outcome.stage, label).toBe("authentication")
          expect(outcome.error.code, label).toBe("identity.revoked")
        }
        // The gate never ran. A revocation answered with "your record is
        // malformed" sends the operator to the wrong place entirely.
        expect(harness.trace(), label).toEqual(["authenticate"])
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a submission whose authenticated peer is not the controller it names", async () => {
    for (const { label, make } of harnesses({
      log: licensingLog(executeCommand()),
      authenticated: nodeIdSchema.parse("node-worker-2"),
    })) {
      const harness = make()
      try {
        const outcome = await harness.inbox.submit(executeCommand())
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") {
          expect(outcome.stage, label).toBe("authentication")
          expect(outcome.error.code, label).toBe("inbox.sender_not_controller")
        }
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("stops at the gate when the gate refuses, and never reaches persistence", async () => {
    for (const { label, make } of harnesses({ gate: refusingGate("epoch_stale", "epoch.stale") })) {
      const harness = make()
      try {
        const outcome = await harness.inbox.submit(executeCommand())
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") {
          expect(outcome.stage, label).toBe("gate")
          expect(outcome.commandId, label).toBeNull()
        }
        expect(harness.trace(), label).toEqual(["authenticate", "gate"])
        expect(await harness.rows(), label).toHaveLength(0)
        expect(harness.acks.emitted, label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a gate that admits without a verified payload, rather than writing from undefined", async () => {
    for (const { label, make } of harnesses({
      gate: new RecordingGate(() => ({ admitted: true })),
    })) {
      const harness = make()
      try {
        const outcome = await harness.inbox.submit(executeCommand())
        expect(outcome.outcome, label).toBe("refused")
        if (outcome.outcome === "refused") {
          // An admission with nothing to persist is a WIRING defect, and this
          // seam persists what it is handed — so writing it would persist a row
          // built from `undefined`.
          expect(outcome.error.code, label).toBe("inbox.gate_incomplete_admission")
          expect(outcome.error.category, label).toBe("internal_failure")
        }
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("the order is stated in the source, so a refactor cannot quietly drop a step", () => {
    // The numbered comments in `#run` ARE the contract. A reorder that leaves
    // the comments describing the old order is the failure mode this catches.
    const body = INBOX_SOURCE.slice(INBOX_SOURCE.indexOf("async #run"))
    const numbered = [...body.matchAll(/\/\/ (\d)\. /g)].map((m) => m[1])
    expect(numbered.slice(0, 6)).toEqual(["1", "2", "3", "4", "5", "6"])
  })
})

describe("M4.5 every admitted command is PERSISTED BEFORE it is acked", () => {
  it("the row is already durable at the instant the ack is handed over", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        expect(harness.acks.emitted, label).toHaveLength(1)
        const emitted = harness.acks.emitted[0]!
        // Read from INSIDE the emitter. Asserting after `submit` returns would
        // pass under either order, because by then the write has happened
        // whichever way round it went.
        expect(emitted.rowsAtEmit, label).toHaveLength(1)
        expect(emitted.rowsAtEmit[0]?.commandId, label).toBe(emitted.commandId)
        expect(emitted.rowsAtEmit[0]?.ackEmittedAt, label).toBeNull()
      } finally {
        harness.close()
      }
    }
  })

  it("persists before acking on the DUPLICATE path too", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        await harness.inbox.recordResult(commandIdSchema.parse("cmd-inbox-1"), { sessionId: "sess-1" })
        harness.clock.set(at(4))
        await harness.inbox.submit(
          executeCommand({ issuedAt: new Date(at(3)).toISOString(), expiresAt: new Date(at(23)).toISOString() }),
        )

        expect(harness.acks.emitted, label).toHaveLength(2)
        const retry = harness.acks.emitted[1]!
        expect(retry.ack.outcome, label).toBe("duplicate")
        // The row was there from the FIRST delivery, carrying the result the
        // duplicate path returned, and the ack path neither cleared it nor rolled
        // it back. A duplicate that rewrote the row would destroy the stored
        // result the retry was answered from.
        expect(retry.rowsAtEmit, label).toHaveLength(1)
        expect(retry.rowsAtEmit[0]?.effectState, label).toBe("result_recorded")
        expect(JSON.parse(retry.rowsAtEmit[0]?.resultJson ?? "null"), label).toEqual({ sessionId: "sess-1" })
        // The duplicate ack carried the SAME sequence as the original, so a
        // controller correlating on position is not sent to a second row.
        expect(retry.acceptedSequence, label).toBe(harness.acks.emitted[0]!.acceptedSequence)
      } finally {
        harness.close()
      }
    }
  })

  it("emits NO ack for a refusal, at any stage", async () => {
    for (const { label, make } of harnesses({ gate: refusingGate("matrix", "command.invalid_run_state") })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        expect(harness.acks.emitted, label).toHaveLength(0)
        expect(await harness.rows(), label).toHaveLength(0)
      } finally {
        harness.close()
      }
    }
  })

  it("emits a REJECTED ack for a conflict, because a conflict must not retire the sender's row", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        await harness.inbox.submit(executeCommand())
        await harness.inbox.submit(executeCommand({ prompt: "Different work" }))
        const conflict = harness.acks.emitted[1]
        expect(conflict?.ack.outcome, label).toBe("rejected")
        expect(conflict?.ack.rejectionCode, label).toBe("duplicate_conflict")
        // And the original row is still there, because "duplicate" would have let
        // the sender retire its row over a command it never ran.
        expect(conflict?.rowsAtEmit, label).toHaveLength(1)
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 acks go out in ACCEPT order", () => {
  it("keeps the sequence monotonic and the ack order identical under concurrency", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        // Three DIFFERENT commands, submitted together. The accept sequence is
        // the ack order, so a controller that receives them in a different order
        // than they were submitted cannot tell "the worker took them out of
        // order" from "the worker reordered my commands" — and the plan's
        // completion criterion is that reordered commands CONVERGE, which needs a
        // determinate order to converge onto.
        const commands = ["cmd-a", "cmd-b", "cmd-c"].map((id) => pauseCommand({ commandId: id }))
        const outcomes = await Promise.all(commands.map((command) => harness.inbox.submit(command)))

        const sequences = outcomes.map((outcome) =>
          outcome.outcome === "accepted" || outcome.outcome === "duplicate" ? outcome.acceptedSequence : -1,
        )
        expect(sequences, label).not.toContain(-1)
        expect([...sequences].sort((a, b) => a - b), label).toEqual(sequences)

        // The acks were emitted in accept order, and the emitter's own view of
        // the sequence matches the row's.
        expect(harness.acks.emitted.map((e) => e.acceptedSequence), label).toEqual(sequences)
        const rows = await harness.rows()
        expect(rows.map((r) => r.acceptedSequence), label).toEqual(sequences)
      } finally {
        harness.close()
      }
    }
  })

  it("gives every accepted command a distinct, gapless sequence", async () => {
    for (const { label, make } of harnesses({ log: licensingLog(executeCommand()) })) {
      const harness = make()
      try {
        for (const id of ["cmd-1", "cmd-2", "cmd-3", "cmd-4"]) {
          await harness.inbox.submit(pauseCommand({ commandId: id }))
        }
        const rows = await harness.rows()
        expect(rows.map((r) => r.acceptedSequence), label).toEqual([1, 2, 3, 4])
        // A REFUSED command must not burn a sequence: the sequence IS the ack
        // order, and an ack emitted for a row that does not exist is an ack about
        // nothing.
        const before = await harness.inbox.peekAcceptedSequence()
        expect(before.ok && before.value, label).toBe(5)
      } finally {
        harness.close()
      }
    }
  })

  it("a refused command does not consume a sequence", async () => {
    for (const { label, make } of harnesses({
      log: licensingLog(executeCommand()),
      gate: new RecordingGate((value) => {
        // Refuse the SECOND command only, so the gap is between two accepts.
        const correlation = (value as { correlationId?: unknown }).correlationId
        if (correlation === "cmd-refused") {
          return {
            admitted: false as const,
            stage: "matrix",
            error: { schemaVersion: 1 as const, category: "conflict" as const, code: "command.invalid_run_state", message: "refused", retryable: false },
          }
        }
        return verifyingAdmission(value)
      }),
    })) {
      const harness = make()
      try {
        await harness.inbox.submit(pauseCommand({ commandId: "cmd-ok-1" }))
        await harness.inbox.submit(pauseCommand({ commandId: "cmd-refused" }))
        await harness.inbox.submit(pauseCommand({ commandId: "cmd-ok-2" }))

        const rows = await harness.rows()
        expect(rows.map((r) => r.acceptedSequence), label).toEqual([1, 2])
        expect(rows.map((r) => r.commandId), label).toEqual(["cmd-ok-1", "cmd-ok-2"])
        expect(harness.acks.emitted.map((e) => e.acceptedSequence), label).toEqual([1, 2])
      } finally {
        harness.close()
      }
    }
  })
})

describe("M4.5 the durable store and the in-memory store agree on every one of these", () => {
  it("both produce the same sequence, the same acks, and the same refusal", async () => {
    const traces: string[][] = []
    for (const label of LABELS) {
      const harness = harnessWith(label, { log: licensingLog(executeCommand()) })
      try {
        await harness.inbox.submit(executeCommand())
        await harness.inbox.submit(executeCommand({ prompt: "Different work" }))
        await harness.inbox.submit(pauseCommand({ commandId: "cmd-after" }))
        traces.push([
          ...harness.trace(),
          `acks:${harness.acks.emitted.map((e) => `${e.ack.outcome}@${e.acceptedSequence}`).join(",")}`,
          `rows:${(await harness.rows()).map((r) => r.acceptedSequence).join(",")}`,
        ])
      } finally {
        harness.close()
      }
    }
    // A semantic drift between the two implementations is the defect this
    // pairing exists to prevent, and it is invisible unless both are driven
    // through the same sequence and their observable behaviour compared.
    expect(traces[0], "the two stores disagree").toEqual(traces[1]!)
  })
})



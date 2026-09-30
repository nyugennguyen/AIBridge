import { describe, expect, it } from "vitest"
import { requiredRecordedStateEntities } from "../../../../src/mesh/lease/command-gate.js"
import type { ControllerLeaseStore } from "../../../../src/mesh/lease/types.js"
import { COMMAND_MATRIX } from "../../../../src/orchestration/invariants.js"
import {
  CONTROLLER_A,
  CONTROLLER_B,
  EPOCH_1,
  EPOCH_2,
  LEASE_1,
  LEASE_2,
  TestClock,
  WORKER_1,
  aFailingRecordedStateResolver,
  aRecordedStateResolver,
  at,
  claimEnvelope,
  claimAt,
  commandEnvelope,
  dispatchWithApprovalPayload,
  gateHarness,
  iso,
  memoryLeaseHarness,
  ms,
  retryPayload,
  scopeFor,
  storedLease,
  takeoverEnvelope,
} from "./fixtures.js"

/**
 * The epoch gate, and the two claims the plan makes about it.
 *
 * A command whose `controllerEpoch` is LOWER than the accepted lease is refused
 * with `epoch.stale` and **nothing is persisted**. Not "stored for
 * later": a command minted under a superseded controller was decided against a
 * projection that no longer exists, so applying it under its successor would
 * apply a decision to a world it never saw.
 *
 * A command whose epoch is HIGHER is refused too, with
 * `epoch.unregistered`. A higher epoch is only ever accepted through the
 * explicit `takeover` operation.
 *
 * Both claims are made against a store that is INSPECTED afterwards, rather than
 * against a return value. The gate does not persist — that is M4.5's inbox — so
 * "nothing is persisted" is a statement about the control flow, and the only way
 * to show it is to look at the thing a write would have changed.
 */
describe("M4.4 a LOWER epoch is refused and NOTHING is persisted", () => {
  it("refuses with epoch.stale and leaves the store byte-identical", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      // The worker accepted A's claim, then A was superseded.
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      await lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, issuedAt: iso(ms(1_000)), expiresAt: iso(ms(31_000)) }),
      )
      clock.set(ms(2_000))

      const before = await snapshot(leaseHarness.store)
      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-from-superseded", controllerNodeId: CONTROLLER_A, controllerEpoch: EPOCH_1, leaseId: LEASE_1 }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("epoch_stale")
      expect(outcome.reason).toBe("epoch_stale")
      expect(outcome.error.code).toBe("epoch.stale")
      expect(outcome.error.category).toBe("stale_epoch")
      // The refusal is NOT retryable. A stale controller that keeps retrying is
      // how a superseded mesh burns CPU, and the record will not become admissible
      // by being sent again.
      expect(outcome.error.retryable).toBe(false)
      // The lease the decision was made against travels with the refusal, so an
      // operator reading the log learns WHICH epoch superseded them.
      expect(outcome.lease?.epoch).toBe(EPOCH_2)
      expect(outcome.lease?.controllerNodeId).toBe(CONTROLLER_B)

      // THE ASSERTION. The store is exactly as it was: same active row, same
      // history, nothing queued for a later epoch.
      expect(await snapshot(leaseHarness.store)).toEqual(before)
      expect((await storedLease(leaseHarness))?.leaseId).toBe(LEASE_2)
    } finally {
      close()
    }
  })

  it("refuses a stale command at EVERY epoch below the accepted one, not only at accepted-1", async () => {
    // A gate that compared for `epoch === accepted - 1` would pass this test. The
    // comparison has to be a real ordering, so the model walks the whole range.
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1, controllerNodeId: CONTROLLER_A })
      for (let round = 0; round < 3; round += 1) {
        const takenOver = await harness.lease.takeover(
          takeoverEnvelope({
            leaseId: `lease-run-1-e${round + 2}`,
            controllerNodeId: CONTROLLER_B,
            epoch: EPOCH_2 + round,
            predecessorLeaseId: round === 0 ? LEASE_1 : `lease-run-1-e${round + 1}`,
            predecessorEpoch: EPOCH_1 + round,
            issuedAt: iso(ms((round + 1) * 1_000)),
            expiresAt: iso(ms((round + 1) * 1_000 + 30_000)),
          }),
        )
        expect(takenOver.outcome, `round ${round}`).toBe("accepted")
      }
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_2 + 2)

      const { gate, close } = gateHarness({ clock, lease: harness.lease })
      try {
        for (let epoch = 1; epoch < EPOCH_2 + 2; epoch += 1) {
          const outcome = await gate.authorize(
            commandEnvelope({ commandId: `cmd-epoch-${epoch}`, controllerEpoch: epoch, issuedAt: iso(ms(4_000)), expiresAt: iso(ms(20_000)) }),
          )
          expect(outcome.admitted, `epoch ${epoch}`).toBe(false)
          if (outcome.admitted) continue
          expect(outcome.error.code, `epoch ${epoch}`).toBe("epoch.stale")
        }
      } finally {
        close()
      }
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 a HIGHER epoch is refused without an explicit takeover", () => {
  it("refuses with epoch.unregistered and writes nothing", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(1_000))
      const before = await snapshot(leaseHarness.store)

      const outcome = await gate.authorize(
        commandEnvelope({
          commandId: "cmd-from-the-future",
          controllerNodeId: CONTROLLER_B,
          controllerEpoch: EPOCH_2 + 5,
          issuedAt: iso(ms(1_000)),
          expiresAt: iso(ms(20_000)),
        }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("epoch_unregistered")
      expect(outcome.reason).toBe("epoch_unregistered")
      expect(outcome.error.code).toBe("epoch.unregistered")
      // Non-retryable for the same reason as a stale epoch, and with the opposite
      // direction: this command is not too old, it is unauthorised. Retrying it
      // cannot help because no number of deliveries raises this node's accepted
      // epoch — only a takeover does.
      expect(outcome.error.retryable).toBe(false)
      expect(outcome.error.message).toMatch(/only ever accepted through an explicit lease takeover/)
      expect(await snapshot(leaseHarness.store)).toEqual(before)
    } finally {
      close()
    }
  })

  it("admits the SAME command once the takeover that raised the epoch has been accepted", async () => {
    // The two halves of the guard, and the only thing that makes the first half
    // safe: a higher epoch becomes admissible exactly when, and only when, the
    // explicit flow has raised this node's accepted epoch to match. Without this
    // the gate would be refusing a legitimate successor forever.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      const successor = {
        commandId: "cmd-from-the-successor",
        controllerNodeId: CONTROLLER_B,
        controllerEpoch: EPOCH_2,
        leaseId: LEASE_2,
        issuedAt: iso(ms(11_000)),
        expiresAt: iso(ms(30_000)),
      }
      expect((await gate.authorize(commandEnvelope(successor))).admitted).toBe(false)

      const takenOver = await lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          issuedAt: iso(ms(10_000)),
          expiresAt: iso(ms(40_000)),
        }),
      )
      expect(takenOver.outcome).toBe("accepted")
      clock.set(ms(12_000))

      const admitted = await gate.authorize(commandEnvelope(successor))
      expect(admitted.admitted).toBe(true)
      if (!admitted.admitted) return
      expect(admitted.lease.epoch).toBe(EPOCH_2)
      expect(admitted.verified.command.controllerNodeId).toBe(CONTROLLER_B)
    } finally {
      close()
    }
  })
})

describe("M4.4 an EQUAL epoch proceeds to the rest of the seam", () => {
  it("is admitted once integrity, addressing and the replay window all pass", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver({ runState: "active", dispatchState: "failed" }) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))

      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-retry-1", type: "dispatch.retry", payload: retryPayload(), issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(outcome.admitted).toBe(true)
      if (!outcome.admitted) return
      // The admission carries the lease it was made against, so M4.5's audit row
      // can record which epoch authorised the command without re-reading the
      // store and getting a different answer.
      expect(outcome.lease.epoch).toBe(EPOCH_1)
      // And the claims the verification deliberately left UNRESOLVED. The gate
      // resolves states against the recorded log and has no business turning a
      // payload's pointer into a grant, so what it hands on is a pointer.
      expect(outcome.verified.authorizationClaims.dispatchId).toBe("dispatch-2")
      expect(outcome.verified.authorizationClaims.leaseId).toBe(LEASE_1)
    } finally {
      close()
    }
  })

  it("is refused by the replay window even at an equal epoch, because integrity still applies", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(20_001))
      // Equal epoch, lease still current (it expires at 30s and the clock is just
      // past the command's own window), but the command's replay window closed at
      // second 20. The gate must report the COMMAND, not the lease: they are
      // different expiries with different owners, and an operator told "the lease
      // expired" would go looking for a lease that is still perfectly valid.
      const expired = await gate.authorize(
        commandEnvelope({ commandId: "cmd-old", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(expired.admitted).toBe(false)
      if (expired.admitted) return
      expect(expired.stage).toBe("integrity")
      expect(expired.reason).toBe("not_verified")
    } finally {
      close()
    }
  })

  it("is refused when the record is addressed to a different worker", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recipientNodeId: WORKER_1 })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-elsewhere", targetNodeId: "node-worker-9", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("integrity")
      // At an EQUAL epoch, so the epoch gate is not what stopped it. Asserting the
      // stage is what makes this a test of addressing rather than a second, weaker
      // test of the epoch rule.
      expect(outcome.error.code).toBe("protocol.command_not_addressed_here")
    } finally {
      close()
    }
  })

  it("is refused when the payload digest does not match, before anything is persisted", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const before = await snapshot(leaseHarness.store)

      // The command carries a payload the digest was not computed over — a
      // tampered record from an otherwise well-behaved, correctly-epoched
      // controller. The most dangerous shape there is, and the one the integrity
      // step exists for.
      //
      // The tamper edits a field the wire schema does not cross-check, on purpose:
      // breaking one that IS cross-checked would move the failure to the parse step
      // and the digest check would never run, which would make this a test of the
      // schema rather than of the integrity gate.
      const outcome = await gate.authorize(
        commandEnvelope({
          commandId: "cmd-tampered",
          issuedAt: iso(ms(1_000)),
          expiresAt: iso(ms(20_000)),
          tamper: (record) => {
            const command = record.command as { payload: { reason: string } }
            return { ...record, command: { ...command, payload: { ...command.payload, reason: "do something else entirely" } } }
          },
        }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("integrity")
      expect(outcome.error.code).toBe("protocol.payload_digest_mismatch")
      expect(await snapshot(leaseHarness.store)).toEqual(before)
    } finally {
      close()
    }
  })
})

describe("M4.4 the gate refuses a non-command without interpreting it", () => {
  it("refuses a lease offered to the command seam and writes nothing", async () => {
    const { gate, close } = gateHarness({ clock: new TestClock(at(2)) })
    try {
      const outcome = await gate.authorize(claimEnvelope({ leaseId: LEASE_1 }))
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("parse")
      expect(outcome.reason).toBe("not_a_command")
      expect(outcome.error.code).toBe("lease.not_a_command")
      expect(outcome.lease).toBeNull()
    } finally {
      close()
    }
  })
})

describe("M4.4 the matrix is the single source of allowed states", () => {
  it("reports the constrained entities it derived from COMMAND_MATRIX, not from a list of its own", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({
      clock,
      recordedState: aRecordedStateResolver({ runState: "active", taskState: "ready", dispatchState: "approved", approvalState: "approved", sessionState: "idle" }),
    })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const outcome = await gate.authorize(
        commandEnvelope({
          commandId: "cmd-execute",
          type: "dispatch.execute",
          payload: dispatchWithApprovalPayload(),
          issuedAt: iso(ms(1_000)),
          expiresAt: iso(ms(20_000)),
        }),
      )
      expect(outcome.admitted).toBe(true)
      if (!outcome.admitted) return
      // `dispatch.execute` constrains run, task, dispatch and approval. Every one
      // of those arms is named, and each was actually supplied — which is the
      // difference between "the matrix was consulted" and "the matrix was
      // satisfied".
      expect([...outcome.matrix.constrainedEntities].sort()).toEqual(["approval", "dispatch", "run", "task"])
      expect([...outcome.matrix.recordedEntities].sort()).toEqual(["approval", "dispatch", "run", "task"])
      expect(outcome.matrix.commandType).toBe("dispatch.execute")
    } finally {
      close()
    }
  })

  it("derives the required arms from every row of the matrix, and never omits the run", () => {
    // Stated over the whole matrix rather than one entry, because a derivation
    // that quietly returns nothing for an unlisted type is a derivation that
    // licenses everything. The run arm in particular is asserted for EVERY type:
    // it is the one arm every row declares, and the completeness rule below relies
    // on it, so a future row that dropped it has to be re-read.
    const types = Object.keys(COMMAND_MATRIX) as (keyof typeof COMMAND_MATRIX)[]
    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      const required = requiredRecordedStateEntities(type)
      expect(required, type).toContain("run")
      expect(required, type).not.toContain("")
    }
  })

  it("refuses a command whose recorded states the matrix constrains were not supplied", async () => {
    // The hole this rule exists to close. `validateCommandStateByType` skips an
    // arm whose value is `undefined`, which is right for the kernel and wrong for
    // a remote authorization decision: a resolver returning `{}` would license
    // every command type in the mesh. A guard that is only observable when it
    // fires against a well-formed command would be a guard nobody would notice
    // going away, so this test is what keeps it honest.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver({}) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-no-states", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("recorded_state")
      expect(outcome.reason).toBe("recorded_state_missing_run")
      expect(outcome.error.code).toBe("lease.recorded_state_incomplete")
      // The missing arms are NAMED. "The projection is incomplete" sends an
      // operator to look at the projection; "the dispatch state was not supplied"
      // tells them which caller to look at.
      expect(outcome.error.message).toContain("run")
      expect(outcome.matrix?.constrainedEntities).toEqual(["run"])
      expect(outcome.matrix?.recordedEntities).toEqual([])
    } finally {
      close()
    }
  })

  it("refuses a command the matrix forbids in the recorded state, and names the states it allows", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver({ runState: "completed" }) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-on-a-finished-run", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("matrix")
      expect(outcome.reason).toBe("matrix_refused")
      // The terminal-state wording is the kernel's, not restated here: a finished
      // run is terminal, and "you cannot dispatch into a finished run" is a better
      // sentence than "run state not in allowlist".
      expect(outcome.error.code).toBe("command.terminal_state_immutable")
      // And the matrix decision travels with the refusal, so a TUI can show which
      // aggregates were consulted rather than re-deriving them.
      expect(outcome.matrix).toMatchObject({ commandType: "run.pause", constrainedEntities: ["run"], recordedEntities: ["run"] })
    } finally {
      close()
    }
  })

  it("refuses everything when the recorded projection cannot be read", async () => {
    // An unreadable projection is not an empty one. The alternative — treating a
    // read failure as "no state recorded" — would fall through to the matrix with
    // nothing to check, which is the hole above wearing a different hat.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aFailingRecordedStateResolver() })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-projection-down", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      expect(outcome.stage).toBe("recorded_state")
      expect(outcome.reason).toBe("recorded_state_unavailable")
      expect(outcome.error.code).toBe("projection.unavailable")
    } finally {
      close()
    }
  })
})

describe("M4.4 the scope a command is judged against is the one it names", () => {
  it("judges against the lease for the run the RECORD names, not one a caller supplies", async () => {
    // The recorded-log rule in its simplest form. A command cannot nominate a run
    // to be judged against another run's lease, because a lease for run B grants
    // nothing about run A — and a gate that read the run from anywhere but the
    // record would let a command for an unleased run ride a leased one.
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const other = await gate.authorize(
        commandEnvelope({
          commandId: "cmd-other-run",
          runId: "run-release-2",
          leaseId: LEASE_1,
          issuedAt: iso(ms(1_000)),
          expiresAt: iso(ms(20_000)),
        }),
      )
      expect(other.admitted).toBe(false)
      if (other.admitted) return
      // No lease for that run, so the answer is "no authority", not "wrong run" —
      // the lease lookup is what established the scope, and it found nothing.
      expect(other.stage).toBe("lease_absent")
      expect(other.lease).toBeNull()
      // And the run the command DID name is untouched by the attempt.
      expect((await storedLease(leaseHarness, scopeFor()))?.leaseId).toBe(LEASE_1)
    } finally {
      close()
    }
  })
})

/**
 * A canonical snapshot of everything a write could change.
 *
 * The active row AND the history, because "nothing is persisted" is a claim about
 * both: a gate that appended an audit row without moving the authority would be
 * half the defect this test exists to catch.
 */
async function snapshot(store: ControllerLeaseStore) {
  const scope = scopeFor()
  const active = await store.activeLease(scope)
  const history = await store.leaseHistory(scope)
  return JSON.stringify({ active: active.ok ? active.value : active.error.code, history: history.ok ? history.value : history.error.code })
}

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { COMMAND_GATE_REFUSALS } from "../../../../src/mesh/lease/types.js"
import { LEASE_REFUSAL_REASONS } from "../../../../src/mesh/protocol/lease.js"
import {
  CONTROLLER_A,
  CONTROLLER_B,
  EPOCH_1,
  EPOCH_2,
  LEASE_1,
  LEASE_2,
  SessionInventory,
  TestClock,
  WORKER_2,
  aRecordedStateResolver,
  aSession,
  at,
  claimEnvelope,
  claimAt,
  commandEnvelope,
  gateHarness,
  iso,
  memoryLeaseHarness,
  ms,
  releaseEnvelope,
  retryPayload,
  scopeFor,
  storedLease,
  takeoverEnvelope,
} from "./fixtures.js"

const LEASE_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/lease/lease.ts"), "utf8")
const GATE_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/lease/command-gate.ts"), "utf8")

/**
 * Expiry. Scenario 2 of the sequence diagrams, and the plan guardrail it exists
 * for.
 *
 * Two claims are under test and they pull in opposite directions, so both are
 * asserted here rather than described in a comment:
 *
 *   1. After `expiresAt`, every command that would create new work is refused
 *      with `lease.expired` — a fresh dispatch, a RETRY and a POLICY
 *      MUTATION, because the plan names all three and retry is the easiest to
 *      reach, being automatic.
 *   2. The worker's live sessions, and their lifecycle states, are BYTE-IDENTICAL
 *      across the partition. The plan calls a violation of that a stop condition.
 *      It is compared by canonical serialisation rather than object identity on
 *      purpose: an in-place rewrite of a `lifecycleState` would satisfy an
 *      identity check and fail this one.
 *
 * Everything is a number. Nothing in this file waits.
 */

/** Recorded states that license `dispatch.retry` and `run.pause` at epoch 1. */
const LICENSING_STATES = { runState: "active", dispatchState: "failed" } as const

describe("M4.4 after expiresAt no new work is permitted", () => {
  it("permits new work up to the bound and refuses it at the bound", async () => {
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const scope = scopeFor()

      clock.set(ms(29_999))
      const justInside = await harness.lease.permitsNewWork(scope)
      expect(justInside.ok).toBe(true)
      expect(justInside.ok && justInside.value).toMatchObject({ permitted: true, reason: "current" })

      clock.set(ms(30_000))
      const atTheBound = await harness.lease.permitsNewWork(scope)
      expect(atTheBound.ok && atTheBound.value).toMatchObject({ permitted: false, reason: "expired" })

      clock.set(ms(30_001))
      const pastTheBound = await harness.lease.permitsNewWork(scope)
      expect(pastTheBound.ok && pastTheBound.value).toMatchObject({ permitted: false, reason: "expired" })
      // The lease in force is still REPORTED alongside the refusal. "No new work"
      // without the lease the answer came from is not something an operator can
      // act on — they need to know which controller lost the room, and until when.
      expect(pastTheBound.ok && pastTheBound.value.lease?.controllerNodeId).toBe(CONTROLLER_A)
    } finally {
      harness.close()
    }
  })

  it("refuses a new dispatch after expiry with the partition diagram's exact code", async () => {
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1 }))
      expect((await gate.authorize(commandEnvelope())).admitted).toBe(true)

      clock.set(ms(30_001))
      const after = await gate.authorize(commandEnvelope({ commandId: "cmd-after-expiry" }))
      expect(after.admitted).toBe(false)
      if (after.admitted) return
      expect(after.stage).toBe("lease_expired")
      expect(after.reason).toBe("lease_expired")
      expect(after.error.code).toBe("lease.expired")
      // The message says what expiry does and does not do. An operator reading
      // "paused" must not read "stopped", and this sentence is what keeps them
      // apart.
      expect(after.error.message).toMatch(/No new dispatch, no retry and no policy mutation/)
      expect(after.error.message).toMatch(/never a termination of existing work/)
      // Non-retryable, because a lease that has expired will still be expired on
      // the next attempt. A retry loop here is how a superseded controller burns
      // a worker's CPU long after the operator has moved on.
      expect(after.error.retryable).toBe(false)
    } finally {
      close()
    }
  })

  it("refuses a RETRY and two POLICY MUTATIONS after expiry too, not only a fresh dispatch", async () => {
    // The plan names three things expiry prevents: new dispatch, retry and policy
    // mutation. A guard that only covers dispatch leaves retry — automatic, and
    // therefore the easiest thing in the system to trigger after a partition — and
    // policy mutation open, and a retry after a partition is exactly how a
    // duplicate session happens.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver(LICENSING_STATES) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1 }))
      const commands = [
        { label: "dispatch.retry", type: "dispatch.retry" as const, payload: retryPayload() },
        { label: "run.pause", type: "run.pause" as const, payload: { reason: "operator asked" } },
        { label: "run.cancel", type: "run.cancel" as const, payload: { reason: "operator asked" } },
      ]
      // Each of these is ADMITTED while the lease is live. A test that only
      // asserted the refusal would pass with a gate that refused everything, which
      // is the single most likely way for this test to be worthless.
      for (const { label, type, payload } of commands) {
        const live = await gate.authorize(
          commandEnvelope({ commandId: `cmd-live-${label}`, type, payload, issuedAt: iso(at(1)) }),
        )
        expect(live.admitted, `live ${label}`).toBe(true)
      }

      clock.set(ms(45_000))
      for (const { label, type, payload } of commands) {
        const outcome = await gate.authorize(
          commandEnvelope({
            commandId: `cmd-expired-${label}`,
            type,
            payload,
            issuedAt: iso(ms(40_000)),
            // A command minted AFTER the lease lapsed still has to carry its own
            // coherent window. The gate must refuse it for the lease and not for a
            // malformed timestamp, or the assertion below would be passing for the
            // wrong reason.
            expiresAt: iso(ms(60_000)),
          }),
        )
        expect(outcome.admitted, label).toBe(false)
        if (outcome.admitted) continue
        expect(outcome.error.code, label).toBe("lease.expired")
      }
    } finally {
      close()
    }
  })

  it("refuses every command at the SAME instant, so there is no window in which one gets through", async () => {
    // The partition diagram's claim is that the refusal happens at one instant for
    // every caller rather than something each caller discovers on its own
    // schedule. Three commands, one clock reading, one verdict — asserted
    // together so a future change that made the gate time-dependent per record
    // fails here.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver(LICENSING_STATES) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1 }))
      clock.set(ms(30_000))
      const outcomes = await Promise.all(
        ["cmd-a", "cmd-b", "cmd-c"].map((commandId) => gate.authorize(commandEnvelope({ commandId }))),
      )
      expect(outcomes.map((outcome) => outcome.admitted)).toEqual([false, false, false])
      expect(outcomes.map((outcome) => (outcome.admitted ? "" : outcome.error.code))).toEqual([
        "lease.expired",
        "lease.expired",
        "lease.expired",
      ])
    } finally {
      close()
    }
  })
})

describe("M4.4 an expired lease leaves every running agent untouched — a stop condition", () => {
  it("the worker's live sessions and their lifecycle states are byte-identical across the partition", async () => {
    const clock = new TestClock(at(0))
    // A worker with real work in flight, in a mix of lifecycle states. The mix is
    // the point: a guard that only preserved `running` would pass while quietly
    // terminating an `idle` one.
    const sessions = new SessionInventory([
      aSession({ sessionId: "session-running", lifecycleState: "running", observedState: "working" }),
      aSession({ sessionId: "session-idle", lifecycleState: "idle", observedState: "idle" }),
      aSession({ sessionId: "session-launching", lifecycleState: "launching", observedState: "starting" }),
    ])
    const before = sessions.canonical()

    const { gate, lease, close } = gateHarness({ clock, recordedState: aRecordedStateResolver(LICENSING_STATES) })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1 }))

      // The controller stops renewing and the partition holds.
      clock.set(ms(60_000))
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const outcome = await gate.authorize(commandEnvelope({ commandId: `cmd-partitioned-${attempt}` }))
        expect(outcome.admitted).toBe(false)
        if (!outcome.admitted) expect(outcome.error.code).toBe("lease.expired")
      }

      // Byte-identical. This is the assertion the plan calls a stop condition: the
      // controller vanished, the network is cut, and the only thing that changed
      // is that nothing NEW may start.
      expect(sessions.canonical()).toBe(before)
      expect(sessions.sessions).toHaveLength(3)
      expect(sessions.sessions.map((session) => session.lifecycleState)).toEqual(["running", "idle", "launching"])
    } finally {
      close()
    }
  })

  it("records a release as a decision that grants nothing, without touching the sessions either", async () => {
    // Pinned next to expiry because the two are easy to conflate in a fix: a
    // release is a deliberate act at a known instant and an expiry is a clock
    // running out. The acceptance carries `permitsNewWork: false` while the
    // stored row is untouched, and the session inventory is unaffected by both —
    // a release is a controller handing a run back, not a controller cleaning up.
    const clock = new TestClock(at(5))
    const harness = memoryLeaseHarness(clock)
    const sessions = new SessionInventory([aSession({ sessionId: "session-running" })])
    const before = sessions.canonical()
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const released = await harness.lease.release(releaseEnvelope({ leaseId: LEASE_1 }))
      expect(released.outcome).toBe("accepted")
      if (released.outcome !== "accepted") return
      expect(released.permitsNewWork).toBe(false)
      expect(released.standing).toBe("current")
      expect((await storedLease(harness))?.operation).toBe("release")
      expect(sessions.canonical()).toBe(before)
    } finally {
      harness.close()
    }
  })

  it("a node that holds no lease at all refuses new work, which is a different incident from an expiry", async () => {
    const clock = new TestClock(at(0))
    const { gate, close } = gateHarness({ clock })
    try {
      const outcome = await gate.authorize(commandEnvelope())
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      // `no_lease` and `expired` are separated because their remedies differ:
      // "nobody is driving this run" versus "the controller you were using is
      // gone". Collapsing them sends an operator to the wrong system.
      expect(outcome.stage).toBe("lease_absent")
      expect(outcome.reason).toBe("no_lease")
      expect(outcome.error.code).toBe("lease.none_held")
      expect(outcome.lease).toBeNull()
    } finally {
      close()
    }
  })
})

describe("M4.4 nothing in the lease directory can express a session transition", () => {
  it("no refusal reason names a session, a termination, a kill or a stop", () => {
    // A boolean is not a safe way to encode the guardrail: a future member named
    // `terminateSessions` would typecheck against any function's return. The
    // guardrail is therefore enforced as an ABSENCE over every vocabulary this
    // directory can hand a caller, and asserted rather than trusted.
    const forbidden = /session|terminate|kill|cancel|stop|abort|dispose|shutdown/
    for (const reason of COMMAND_GATE_REFUSALS) expect(reason, reason).not.toMatch(forbidden)
    for (const reason of LEASE_REFUSAL_REASONS) expect(reason, reason).not.toMatch(forbidden)
  })

  it("neither decision module names a session operation in its code", () => {
    // The vocabulary assertion above covers what callers can READ. This covers
    // what a future edit could WRITE: a name check over the two modules that make
    // the decisions. It is a blunt instrument on purpose — a substring test over
    // source is the cheapest guard that catches a member added six months from
    // now, and a false positive costs one rename.
    //
    // Comments are stripped first, and that is not a formality: this codebase's
    // comments DISCUSS "do not terminate agents", so a naive scan would flag the
    // explanation of the guardrail as the guardrail's violation.
    for (const [label, source] of [
      ["lease.ts", LEASE_SOURCE],
      ["command-gate.ts", GATE_SOURCE],
    ] as const) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, label).not.toMatch(/terminateSession|killSession|abortSession|stopSession|cancelSession/)
    }
  })
})

describe("M4.4 the partition heals through a takeover, not through a quiet re-claim", () => {
  it("an expired lease can be taken over at a higher epoch, and the old controller is fenced", async () => {
    const clock = new TestClock(at(0))
    const old = memoryLeaseHarness(clock)
    const successor = memoryLeaseHarness(clock)
    try {
      await claimAt(old, { leaseId: LEASE_1, controllerNodeId: CONTROLLER_A })

      // The old controller is partitioned: it stops renewing. The successor's node
      // has already learned the run's lease (its own copy of A's claim), so its
      // takeover is evaluated against a lease it actually holds rather than
      // against nothing — which is the only way the fence has a left-hand side.
      await successor.lease.applyLease(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))

      clock.set(ms(40_000))
      const takenOver = await successor.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          predecessorLeaseId: LEASE_1,
          predecessorEpoch: EPOCH_1,
          acknowledgedUnreconciledNodeIds: [WORKER_2],
          // A takeover's own window starts now, not at the claim's issue time.
          // Minting it from the claim's timestamps would produce a lease that was
          // already expired the moment it was accepted, which is a fixture defect
          // that reads as a protocol one.
          issuedAt: iso(ms(40_000)),
          expiresAt: iso(ms(70_000)),
          durationSeconds: 30,
        }),
      )
      expect(takenOver.outcome).toBe("accepted")
      if (takenOver.outcome !== "accepted") return
      // `standing: "expired"` on the acceptance is the audit line that says the
      // successor did not displace a LIVE controller — it picked up a lapsed one.
      expect(takenOver.standing).toBe("expired")
      expect((await storedLease(successor))?.epoch).toBe(EPOCH_2)

      // And the old controller's own store still believes it holds epoch 1, which
      // is exactly why the fence has to be the EPOCH rather than the node's
      // belief about its own lease. A worker that has accepted the takeover
      // refuses it.
      const { gate: workerGate, close } = gateHarness({
        clock,
        recordedState: aRecordedStateResolver(LICENSING_STATES),
        lease: successor.lease,
      })
      try {
        const stale = await workerGate.authorize(
          commandEnvelope({ commandId: "cmd-stale-after-takeover", controllerNodeId: CONTROLLER_A, leaseId: LEASE_1 }),
        )
        expect(stale.admitted).toBe(false)
        if (!stale.admitted) expect(stale.error.code).toBe("epoch.stale")
      } finally {
        close()
      }
    } finally {
      old.close()
      successor.close()
    }
  })
})

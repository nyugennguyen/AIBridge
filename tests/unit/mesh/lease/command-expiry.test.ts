import { describe, expect, it } from "vitest"
import type { ControllerLeaseStore } from "../../../../src/mesh/lease/types.js"
import {
  CONTROLLER_A,
  LEASE_1,
  TestClock,
  at,
  claimEnvelope,
  commandEnvelope,
  gateHarness,
  iso,
  ms,
  renewEnvelope,
  scopeFor,
} from "./fixtures.js"

/**
 * A command may not OUTLIVE the lease that minted it. Spec §4.4 invariant 7,
 * stated in the kernel's `validateCommandLease` and nowhere in the mesh — until
 * now, because the epoch gate never compared the two windows.
 *
 * The rule is ABSOLUTE and that is what makes it a separate guard rather than a
 * consequence of the expiry check that sits two steps earlier. "The lease is
 * still current at this instant" is a question about NOW and is answered by
 * `permitsNewWork`; "this command's own window ends inside the lease window it
 * was minted under" is a question about two records and no clock at all. A gate
 * that only had the first would admit a command minted against a thirty-minute
 * lease, delivered twenty-nine minutes later, under a lease that had nine seconds
 * left to run — work whose authority ends before the work does.
 *
 * The third test is the consequence the guard has that a clock check would not
 * have: the comparison binds RETROACTIVELY, so a renewal that SHORTENS the window
 * invalidates a command that was legitimately admitted a moment earlier. That is
 * the kernel's own stated behaviour, and it is asserted here because a future edit
 * "fixing" this to a `now`-relative comparison would look like a strictness
 * improvement and would remove it.
 */
describe("M4.6 a command whose window ends inside the lease window is admitted", () => {
  it("admits one that expires well before the lease, and one that expires exactly AT the lease", async () => {
    // The bound is inclusive and asserted AT the bound, because a strict `<` is
    // the one that looks right and is not: a command expiring at the same instant
    // as the lease it was minted under is not a command that outlives anything,
    // and a guard that refused it would push every controller to shorten its
    // command windows for no safety gain.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))

      for (const [label, expiresAt] of [
        ["inside", iso(ms(20_000))],
        ["at-the-bound", iso(ms(30_000))],
      ] as const) {
        clock.set(ms(2_000))
        const outcome = await gate.authorize(
          commandEnvelope({ commandId: `cmd-window-${label}`, issuedAt: iso(ms(1_000)), expiresAt }),
        )
        expect(outcome.admitted, label).toBe(true)
      }
    } finally {
      close()
    }
  })
})

describe("M4.6 a command that OUTLIVES its lease window is refused, and NOTHING is persisted", () => {
  it("refuses with command.expiry_exceeds_lease while the clock is still inside BOTH windows", async () => {
    // The clock sits at two seconds, so the lease (thirty) and the command's own
    // window (sixty) are both wide open. A check that compared either against the
    // clock would admit this record, which is the whole point: the defect is
    // invisible to every other guard on this path.
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      clock.set(ms(2_000))
      const before = await snapshot(leaseHarness.store)

      const outcome = await gate.authorize(
        commandEnvelope({ commandId: "cmd-outlives-its-lease", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(60_000)) }),
      )
      expect(outcome.admitted).toBe(false)
      if (outcome.admitted) return
      // The kernel's spelling, not a mesh-private one: `command.expiry_exceeds_
      // lease` is the code `validateCommandLease` raises for the same fact, and a
      // second spelling would be a second vocabulary for one guard.
      expect(outcome.error.code).toBe("command.expiry_exceeds_lease")
      expect(outcome.stage).toBe("lease_window")
      expect(outcome.reason).toBe("command_expiry_exceeds_lease")
      // Not retryable. Re-sending the same bytes produces the same refusal, and a
      // sender that treated this as a transient failure would redeliver until it
      // exhausted its attempts — against a rule no amount of delivery changes.
      expect(outcome.error.retryable).toBe(false)
      // Both windows are named, so the operator does not have to go and look up
      // either record to see which one is wrong.
      expect(outcome.error.message).toContain(iso(ms(60_000)))
      expect(outcome.error.message).toContain(iso(ms(30_000)))
      // And the lease the decision was made against travels with the refusal, as
      // every gate refusal does.
      expect(outcome.lease?.leaseId).toBe(LEASE_1)
      expect(await snapshot(leaseHarness.store)).toEqual(before)
    } finally {
      close()
    }
  })

  it("refuses a command one millisecond past the bound, and admits it one millisecond inside", async () => {
    // The comparison has to be a real ordering. A guard written as
    // `expiresAt >= lease.expiresAt` would pass the previous test, and this is
    // what tells the two apart.
    const clock = new TestClock(at(0))
    const { gate, lease, close } = gateHarness({ clock })
    try {
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))

      clock.set(ms(2_000))
      const inside = await gate.authorize(
        commandEnvelope({ commandId: "cmd-one-ms-inside", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(29_999)) }),
      )
      expect(inside.admitted).toBe(true)

      clock.set(ms(2_000))
      const outside = await gate.authorize(
        commandEnvelope({ commandId: "cmd-one-ms-outside", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(30_001)) }),
      )
      expect(outside.admitted).toBe(false)
      if (outside.admitted) return
      expect(outside.error.code).toBe("command.expiry_exceeds_lease")
    } finally {
      close()
    }
  })
})

describe("M4.6 the lease window binds RETROACTIVELY", () => {
  it("a renewal that SHORTENS the window invalidates a command admitted under the longer one", async () => {
    // The rule binds backwards, which surprises callers and is deliberate. A
    // command is minted against ONE specific lease window; a renewal that shortens
    // that window says the authority behind the command ends earlier than the
    // command does, and the command's own window is now longer than the authority
    // it was issued under. Failing a command that was admissible a moment ago is
    // the cheap direction — the alternative is accepting a command whose authority
    // has ended — but it is only correct if the guard is doing it, so this is
    // asserted rather than left as a comment in `invariants.ts`.
    const clock = new TestClock(at(0))
    const { gate, lease, leaseHarness, close } = gateHarness({ clock })
    try {
      // A thirty-second lease, claimed at T0.
      await lease.claim(claimEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A }))
      expect((await storedExpiry(leaseHarness.store))).toBe(iso(ms(30_000)))

      // A command that fits inside it, offered while it fits.
      clock.set(ms(2_000))
      const admitted = await gate.authorize(
        commandEnvelope({ commandId: "cmd-minted-under-the-long-window", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(admitted.admitted).toBe(true)

      // The same controller SHORTENS its own window to ten seconds from T0. A
      // shortening renewal is accepted by the protocol — nothing forbids a
      // controller from giving up authority — which is exactly why the command
      // guard has to notice.
      clock.set(ms(5_000))
      const renewed = await lease.renew(
        renewEnvelope({ leaseId: LEASE_1, controllerNodeId: CONTROLLER_A, issuedAt: iso(ms(5_000)), expiresAt: iso(ms(10_000)), durationSeconds: 5 }),
      )
      expect(renewed.outcome).toBe("accepted")
      expect((await storedExpiry(leaseHarness.store))).toBe(iso(ms(10_000)))

      // The lease is still CURRENT — the clock is at six seconds of a ten-second
      // window — and the command's own window is still open until twenty. The
      // command is refused anyway, on the two windows and no clock.
      clock.set(ms(6_000))
      const after = await gate.authorize(
        commandEnvelope({ commandId: "cmd-minted-under-the-long-window", issuedAt: iso(ms(1_000)), expiresAt: iso(ms(20_000)) }),
      )
      expect(after.admitted).toBe(false)
      if (after.admitted) return
      expect(after.stage).toBe("lease_window")
      expect(after.error.code).toBe("command.expiry_exceeds_lease")
      // And the message points at the LEASE, because the lease is what moved.
      // A sender reading "your expiry is too late" without being told the window
      // moved would re-mint against the same wrong assumption.
      expect(after.error.message).toContain(LEASE_1)
    } finally {
      close()
    }
  })
})

/** The stored lease's `expiresAt`, or `null`. Throws rather than returning a `Result`. */
async function storedExpiry(store: ControllerLeaseStore): Promise<string | null> {
  const found = await store.activeLease(scopeFor())
  if (!found.ok) throw new Error(`fixture lease read failed: ${found.error.code}`)
  return found.value?.expiresAt ?? null
}

/** A canonical snapshot of everything a write could change: the active row AND the history. */
async function snapshot(store: ControllerLeaseStore) {
  const scope = scopeFor()
  const active = await store.activeLease(scope)
  const history = await store.leaseHistory(scope)
  return JSON.stringify({ active: active.ok ? active.value : active.error.code, history: history.ok ? history.value : history.error.code })
}

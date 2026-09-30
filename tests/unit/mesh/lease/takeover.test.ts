import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MeshControllerLease } from "../../../../src/mesh/lease/lease.js"
import { LEASE_OPERATIONS } from "../../../../src/mesh/protocol/lease.js"
import {
  CONTROLLER_A,
  CONTROLLER_B,
  EPOCH_1,
  EPOCH_2,
  EPOCH_3,
  LEASE_1,
  LEASE_2,
  LEASE_3,
  TestClock,
  WORKER_1,
  WORKER_2,
  WORKER_3,
  aLease,
  at,
  claimAt,
  claimEnvelope,
  iso,
  memoryLeaseHarness,
  ms,
  scopeFor,
  storedLease,
  takeoverEnvelope,
} from "./fixtures.js"

const LEASE_DIRECTORY = join(import.meta.dirname, "../../../../src/mesh/lease")

/**
 * Takeover: the ONE operation that may raise the epoch, and the two preconditions
 * that guard it.
 *
 * §4.7 invariant 4 requires a strictly higher epoch AND the user having
 * inspected the unreconciled nodes. Neither substitutes for the other, and the
 * file asserts both directions of that: a takeover with a higher epoch and no
 * acknowledgement is refused, and a takeover with an acknowledgement and no
 * higher epoch is refused. A test that only checked one would pass against an
 * implementation that had implemented half the rule.
 */
describe("M4.4 a takeover needs a strictly higher epoch", () => {
  it("is accepted at epoch + 1 and is refused at the same epoch and below", async () => {
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1 })

      const sameEpoch = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_1 }),
      )
      expect(sameEpoch.outcome).toBe("refused")
      if (sameEpoch.outcome !== "refused") return
      // A takeover that does not raise the epoch fences nothing, so accepting it
      // would leave two controllers believing they had superseded each other.
      expect(sameEpoch.reason).toBe("epoch_not_increasing")
      expect(sameEpoch.error.code).toBe("lease.takeover_not_increasing")

      const above = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2 }),
      )
      expect(above.outcome).toBe("accepted")
      if (above.outcome !== "accepted") return
      expect(above.permitsNewWork).toBe(true)
      // Standing `current` on this acceptance: the successor DISPLACED a live
      // controller, deliberately, and the audit line has to say so. A takeover at
      // `expired` standing is the partition healing, which is a different event
      // with a different question to answer at an audit.
      expect(above.standing).toBe("current")
    } finally {
      harness.close()
    }
  })

  it("refuses a takeover that names a predecessor lease or epoch the node does not hold", async () => {
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })

      // A takeover that could omit the predecessor would be a way to seize a run by
      // asserting a high epoch alone, so the fence is named and checked.
      for (const override of [
        { predecessorLeaseId: "lease-somewhere-else" },
        { predecessorEpoch: EPOCH_3 },
      ]) {
        const outcome = await harness.lease.takeover(
          takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, ...override }),
        )
        expect(outcome.outcome, JSON.stringify(override)).toBe("refused")
        if (outcome.outcome !== "refused") continue
        expect(outcome.reason, JSON.stringify(override)).toBe("predecessor_mismatch")
      }
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
    } finally {
      harness.close()
    }
  })

  it("records the predecessor, the reason and the inspected nodes in the stored takeover", async () => {
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const outcome = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          acknowledgedUnreconciledNodeIds: [WORKER_2, WORKER_3],
        }),
      )
      expect(outcome.outcome).toBe("accepted")
      if (outcome.outcome !== "accepted") return

      const stored = await storedLease(harness)
      expect(stored).toMatchObject({
        leaseId: LEASE_2,
        controllerNodeId: CONTROLLER_B,
        epoch: EPOCH_2,
        operation: "takeover",
        predecessorLeaseId: LEASE_1,
        predecessorEpoch: EPOCH_1,
        acknowledgedUnreconciledNodeIds: [WORKER_2, WORKER_3],
      })
      // A takeover with no recorded reason is a takeover nobody can audit six
      // months later, so the reason is a required field rather than a convention.
      expect(stored?.takeoverReason).toMatch(/operator moved control/)
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 a takeover needs the user to have inspected the unreconciled nodes", () => {
  it("refuses an empty acknowledgement while unreconciled nodes exist, and NAMES them", async () => {
    // The precondition's whole content is the list. An empty list is the shape it
    // is about, and the refusal has to name the node ids so the operator is shown
    // what they have not looked at rather than told "there are some".
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      harness.unreconciled.set(scopeFor(), [WORKER_2, WORKER_3])

      const refused = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, acknowledgedUnreconciledNodeIds: [] }),
      )
      expect(refused.outcome).toBe("refused")
      if (refused.outcome !== "refused") return
      expect(refused.reason).toBe("unreconciled_nodes_not_acknowledged")
      expect(refused.error.code).toBe("lease.takeover_unreconciled")
      expect(refused.error.message).toContain(WORKER_2)
      expect(refused.error.message).toContain(WORKER_3)
      // And nothing was written, which is the half that matters operationally: a
      // refused takeover that had already moved the epoch would be a fence nobody
      // asked for.
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
    } finally {
      harness.close()
    }
  })

  it("refuses a PARTIAL acknowledgement, naming only the ones still missing", async () => {
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      harness.unreconciled.set(scopeFor(), [WORKER_2, WORKER_3])

      const refused = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          acknowledgedUnreconciledNodeIds: [WORKER_2],
        }),
      )
      expect(refused.outcome).toBe("refused")
      if (refused.outcome !== "refused") return
      // The already-acknowledged node is NOT named again. Repeating it would put
      // noise in the one sentence the operator reads, and the whole value of the
      // message is that it says exactly what is left to do.
      // The message names what is STILL MISSING in its own clause, and echoes the
      // acknowledgement separately so the operator can see the two lists side by
      // side and tell which is which. Both halves are load-bearing: the
      // acknowledged list is the progress already made, and the remainder is the
      // work left.
      expect(refused.error.message).toMatch(/1 unreconciled node\(s\) remain: \[node-worker-3\]/)
      expect(refused.error.message).toMatch(/acknowledges \[node-worker-2\]/)
    } finally {
      harness.close()
    }
  })

  it("accepts a complete acknowledgement, and accepts an empty one when nothing is unreconciled", async () => {
    // The second half matters: the precondition is about UNRECONCILED NODES, not
    // about a list that must be non-empty. A mesh in full agreement must still be
    // able to take over, and a rule demanding a non-empty list would push an
    // operator to acknowledge a node that does not exist.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const clean = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, acknowledgedUnreconciledNodeIds: [] }),
      )
      expect(clean.outcome).toBe("accepted")
    } finally {
      harness.close()
    }

    const degraded = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(degraded, { leaseId: LEASE_1 })
      degraded.unreconciled.set(scopeFor(), [WORKER_2])
      const accepted = await degraded.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          acknowledgedUnreconciledNodeIds: [WORKER_2],
        }),
      )
      expect(accepted.outcome).toBe("accepted")
    } finally {
      degraded.close()
    }
  })

  it("checks the acknowledgement against the node's OWN unreconciled set, not the record's claim", async () => {
    // The recorded-log rule, applied to the one field whose entire purpose is to
    // be an assertion about what a human saw. If the record's own list were the
    // input, the guard would be checking the claimant's list against itself and
    // would be vacuous.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      // The record claims W1 was inspected; this node's reconciliation says W2 and
      // W3 were not. W1 is not in the node's set, so acknowledging it is not
      // evidence about anything.
      harness.unreconciled.set(scopeFor(), [WORKER_2, WORKER_3])
      const refused = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          acknowledgedUnreconciledNodeIds: [WORKER_1],
        }),
      )
      expect(refused.outcome).toBe("refused")
      if (refused.outcome !== "refused") return
      expect(refused.reason).toBe("unreconciled_nodes_not_acknowledged")
      expect(refused.error.message).toContain(WORKER_2)
    } finally {
      harness.close()
    }
  })

  it("stores what the node's reconciliation REPORTED alongside what the user acknowledged", async () => {
    // The two lists are different facts and the audit needs both. The
    // acknowledgement is the answer the user gave; the stored `unreconciledNodeIds`
    // is the question they were answering. A takeover record that carried only
    // the first cannot answer "was the user actually shown these nodes", which is
    // the only question the guard exists to make answerable.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      harness.unreconciled.set(scopeFor(), [WORKER_2, WORKER_3])
      const outcome = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          acknowledgedUnreconciledNodeIds: [WORKER_2, WORKER_3],
        }),
      )
      expect(outcome.outcome).toBe("accepted")
      if (outcome.outcome !== "accepted") return
      expect(outcome.lease.acknowledgedUnreconciledNodeIds).toEqual([WORKER_2, WORKER_3])
      expect(outcome.lease.unreconciledNodeIds).toEqual([WORKER_2, WORKER_3])
    } finally {
      harness.close()
    }
  })

  it("neither half of the precondition substitutes for the other", async () => {
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      harness.unreconciled.set(scopeFor(), [WORKER_2])

      const noHigherEpoch = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_1,
          acknowledgedUnreconciledNodeIds: [WORKER_2],
        }),
      )
      expect(noHigherEpoch.outcome === "refused" && noHigherEpoch.reason).toBe("epoch_not_increasing")

      const noAcknowledgement = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, acknowledgedUnreconciledNodeIds: [] }),
      )
      expect(noAcknowledgement.outcome === "refused" && noAcknowledgement.reason).toBe("unreconciled_nodes_not_acknowledged")

      expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 no automatic election exists", () => {
  it("the wire vocabulary offers exactly four operations and exactly one raises the epoch", () => {
    // Stated against the wire's own vocabulary rather than a list written here, so
    // the assertion cannot drift from the protocol: a fifth operation added to
    // `LEASE_OPERATIONS` makes this fail until someone says what it does to the
    // epoch.
    expect([...LEASE_OPERATIONS].sort()).toEqual(["claim", "release", "renew", "takeover"])
  })

  it("the lease seam exposes exactly one epoch-raising method", () => {
    const methods = Object.getOwnPropertyNames(MeshControllerLease.prototype).filter((name) => name !== "constructor")
    expect(methods.filter((name) => name.startsWith("#"))).toEqual([])
    expect(methods.sort()).toEqual(
      ["applyLease", "claim", "heldLease", "lease", "permitsNewWork", "release", "renew", "setUnreconciledNodeIds", "takeover"].sort(),
    )
  })

  it("no module in the lease directory mentions election, quorum, gossip or consensus", () => {
    // The plan's guardrail is "do not implement auto-election, quorum, gossip, or
    // consensus", and a guardrail against something that is ABSENT is only
    // checkable by looking. Comments are stripped: this codebase's comments
    // DISCUSS the guardrail, and a naive scan would flag the discussion.
    const forbidden = /auto-?elect|quorum|gossip|consensus|leader-?election|raft|paxos/i
    for (const file of readdirSync(LEASE_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(LEASE_DIRECTORY, file), "utf8")
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, file).not.toMatch(forbidden)
    }
  })

  it("a node holding no lease accepts a claim, and a held one is only raised by a takeover", async () => {
    // The "no election" property stated as behaviour rather than as absence: an
    // unheld run may be claimed at any epoch, and a HELD one may only be raised by
    // a takeover that names what it fences. There is no third option, and this
    // exercises both halves against the same run.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      const claimed = await harness.lease.claim(claimEnvelope({ leaseId: LEASE_1, epoch: EPOCH_3 }))
      expect(claimed.outcome).toBe("accepted")
      if (claimed.outcome === "accepted") expect(claimed.lease.epoch).toBe(EPOCH_3)

      // Now a controller that merely CLAIMS a higher epoch against the held lease,
      // and one that RENEWS the held lease at a higher epoch. Both are attempts to
      // raise the authority without the takeover flow, and both are refused as
      // unregistered. This is the guardrail, asserted as behaviour: a "helpful"
      // automatic upgrade is exactly the election the milestone forbids, and it
      // would look like this.
      const attempts = [
        { operation: "claim" as const, envelope: claimEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_3 + 1 }) },
        {
          operation: "renew" as const,
          envelope: claimEnvelope({
            leaseId: LEASE_1,
            controllerNodeId: CONTROLLER_A,
            epoch: EPOCH_3 + 1,
            operation: "renew",
            issuedAt: iso(ms(1_000)),
            expiresAt: iso(ms(31_000)),
          }),
        },
      ]
      for (const attempt of attempts) {
        const outcome = await harness.lease[attempt.operation](attempt.envelope)
        expect(outcome.outcome, attempt.operation).toBe("refused")
        if (outcome.outcome !== "refused") continue
        expect(outcome.reason, attempt.operation).toBe("epoch_unregistered")
        expect(outcome.error.code, attempt.operation).toBe("epoch.unregistered")
        // Non-retryable, so a controller that keeps trying cannot turn a refused
        // epoch bump into a slow busy-loop against the operator's peers.
        expect(outcome.error.retryable, attempt.operation).toBe(false)
      }
      expect((await storedLease(harness))?.controllerNodeId).toBe(CONTROLLER_A)
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 a takeover needs something to take over FROM", () => {
  it("refuses a takeover on a run this node holds no lease for", async () => {
    // The predecessor comparison used to run only when there WAS a lease in
    // force, so a node holding nothing accepted a takeover at any epoch with
    // nothing checked — and `split-brain.test.ts` found the consequence: a
    // controller that never received the run's lease broadcasts one, every node
    // that already holds the real lease refuses it, every node that holds nothing
    // accepts it, and the mesh ends up with one controller per worker and TWO
    // controllers driving one run. That is the plan's stop condition, reached by an
    // unargued path.
    //
    // The rule is now in `evaluateLease`, so this seam asserts the same refusal
    // every node does rather than a stricter private one. The cost is real and is
    // not hidden: a node that lost its lease store and restarted cannot be brought
    // onto an epoch until reconciliation re-delivers the lease. Failing closed on
    // an authority decision is the right direction, and the recovery path exists.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      const outcome = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2, predecessorLeaseId: LEASE_1, predecessorEpoch: EPOCH_1 }),
      )
      expect(outcome.outcome).toBe("refused")
      if (outcome.outcome !== "refused") return
      expect(outcome.reason).toBe("no_lease_to_fence")
      expect(outcome.error.code).toBe("lease.no_lease_to_fence")
      expect(outcome.standing).toBe("none")
      expect((await storedLease(harness))).toBeNull()

      // And the answer names the operation that DOES mean "I am starting", so an
      // operator is not left with a refusal and no next step.
      expect(outcome.error.message).toMatch(/claim/)
    } finally {
      harness.close()
    }
  })

  it("still accepts the same takeover once the node has the lease it fences", async () => {
    // The guard must not be a blanket refusal, or it would make the takeover
    // impossible — which is the opposite of what "only through the explicit flow"
    // means.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1, controllerNodeId: CONTROLLER_A })
      const outcome = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, controllerNodeId: CONTROLLER_B, epoch: EPOCH_2 }),
      )
      expect(outcome.outcome).toBe("accepted")
    } finally {
      harness.close()
    }
  })

  it("leaves a CLAIM as the way to drive an unheld run, at any epoch", async () => {
    // The escape hatch is not theoretical. A brand-new run has no predecessor to
    // name, so `claim` is the only operation that can start it, and it is not
    // epoch-constrained against nothing.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      const claimed = await harness.lease.claim(claimEnvelope({ leaseId: LEASE_1, epoch: EPOCH_3 }))
      expect(claimed.outcome).toBe("accepted")
      if (claimed.outcome === "accepted") expect(claimed.standing).toBe("none")
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 successive takeovers keep the chain auditable", () => {
  it("records every superseded lease in order, so the fence has a history", async () => {
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1, issuedAt: iso(at(0)), expiresAt: iso(at(30)) })

      const first = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          issuedAt: iso(ms(10_000)),
          expiresAt: iso(ms(40_000)),
          durationSeconds: 30,
        }),
      )
      expect(first.outcome).toBe("accepted")

      const second = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_3,
          controllerNodeId: CONTROLLER_A,
          epoch: EPOCH_3,
          predecessorLeaseId: LEASE_2,
          predecessorEpoch: EPOCH_2,
          issuedAt: iso(ms(20_000)),
          expiresAt: iso(ms(50_000)),
          durationSeconds: 30,
        }),
      )
      expect(second.outcome).toBe("accepted")

      const history = await harness.store.leaseHistory(scopeFor())
      expect(history.ok).toBe(true)
      if (!history.ok) return
      // Three links, each naming the one before it. A takeover that could only
      // report the lease it replaced would let a chain of three be told as two
      // unrelated claims.
      expect(history.value.map((entry) => [entry.leaseId, entry.epoch, entry.operation])).toEqual([
        [LEASE_1, EPOCH_1, "claim"],
        [LEASE_2, EPOCH_2, "takeover"],
        [LEASE_3, EPOCH_3, "takeover"],
      ])
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_3)
    } finally {
      harness.close()
    }
  })

  it("a takeover whose predecessor is not the lease in force is refused, so the chain cannot be forked", async () => {
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1, issuedAt: iso(at(0)), expiresAt: iso(at(30)) })
      await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_2,
          controllerNodeId: CONTROLLER_B,
          epoch: EPOCH_2,
          issuedAt: iso(ms(10_000)),
          expiresAt: iso(ms(40_000)),
          durationSeconds: 30,
        }),
      )
      // A contender naming the ORIGINAL lease is refused even though its epoch is
      // higher, because the fence it claims to be based on is two links back. This
      // is what stops a partitioned controller from re-taking a run it once held.
      const forked = await harness.lease.takeover(
        takeoverEnvelope({
          leaseId: LEASE_3,
          controllerNodeId: CONTROLLER_A,
          epoch: EPOCH_3,
          predecessorLeaseId: LEASE_1,
          predecessorEpoch: EPOCH_1,
          issuedAt: iso(ms(20_000)),
          expiresAt: iso(ms(50_000)),
          durationSeconds: 30,
        }),
      )
      expect(forked.outcome).toBe("refused")
      if (forked.outcome === "refused") expect(forked.reason).toBe("predecessor_mismatch")
      expect((await storedLease(harness))?.leaseId).toBe(LEASE_2)
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 the wire record and the stored record agree on a takeover", () => {
  it("round-trips the takeover through the wire schema with the nullable fields made explicit", () => {
    // The stored shape is the wire shape plus nulls and the node's own
    // reconciliation. A test that only checked the stored row would not notice if
    // a nullable column were written from a field the wire schema never had.
    const wire = aLease({
      operation: "takeover",
      leaseId: LEASE_2,
      controllerNodeId: CONTROLLER_B,
      epoch: EPOCH_2,
      predecessorLeaseId: LEASE_1,
      predecessorEpoch: EPOCH_1,
      takeoverReason: "operator moved control",
      acknowledgedUnreconciledNodeIds: [WORKER_2],
    })
    expect(wire.predecessorLeaseId).toBe(LEASE_1)
    expect(wire.predecessorEpoch).toBe(EPOCH_1)
    expect(wire.acknowledgedUnreconciledNodeIds).toEqual([WORKER_2])
  })
})


/**
 * M4.6 — the plan's six reconciliation steps, in order.
 *
 * Two things are load-bearing here, and both are properties of ORDER rather than of
 * any single step's answer:
 *
 *   1. **Steps 4 and 5 do not run unless 1–3 all pass.** A superseded controller's
 *      resend list is a set of decisions taken against a projection that no longer
 *      exists, and its session inventory is an observation about a run it no longer
 *      drives. So the gate is an ordering of SIDE EFFECTS: a stale controller must
 *      not cause a durable read, let alone a write. The fakes record which stores
 *      were consulted and in what order, which is the only way to see that.
 *   2. **Step 3's accepted epoch comes from M4.4's lease**, and there is no second
 *      epoch rule in this directory. A reconciler that could raise an epoch would be
 *      an automatic election, which the milestone forbids.
 *
 * Step 6 is a property of the RESPONSE TYPE, not of this handler's discipline, and
 * `reconcile-response-cannot-act.test.ts` asserts it structurally.
 *
 * Nothing sleeps and nothing reads a clock: the reconciler takes its time from the
 * lease rather than from a wall clock, so every scenario here is a constructed
 * request rather than a simulated network.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MeshReconciler, RECONCILE_RESEND_LIMIT } from "../../../../../src/mesh/gateway/reconcile/index.js"
import { ARRAY_MAX } from "../../../../../src/mesh/protocol/identifiers.js"
import type { ReplayScope } from "../../../../../src/mesh/gateway/events/index.js"
import type { SnapshotFallback } from "../../../../../src/mesh/protocol/reconciliation.js"
import { EPOCH, OTHER_WORKER, PROJECT, RUN, WORKER, reconcileRequestEnvelope } from "../fixtures.js"
import { FakeLease, FakeProjections, FakeUnacknowledged, SCOPE, storeUnavailable } from "./fixtures.js"

const RECONCILER_SOURCE = readFileSync(join(import.meta.dirname, "../../../../../src/mesh/gateway/reconcile/reconciler.ts"), "utf8")
const PORT_SOURCE = readFileSync(join(import.meta.dirname, "../../../../../src/mesh/gateway/reconcile/types.ts"), "utf8")

/** A reconciler over three fakes, with every fake returned for the ordering assertions. */
function aReconciler(overrides: { readonly epoch?: number | null } = {}) {
  const lease = new FakeLease(overrides.epoch === undefined ? EPOCH : overrides.epoch)
  const unacknowledged = new FakeUnacknowledged().seed(["cmd-1", "cmd-2"], ["evt-1"])
  const projections = new FakeProjections().seed([{ dispatchId: "dispatch-gateway-1", sessionId: "sess-gateway-1" }])
  return { lease, unacknowledged, projections, reconciler: new MeshReconciler({ lease, unacknowledged, projections }) }
}

/** The request the fixture builds, with the peer reporting one session the controller knows about. */
const MATCHING_INVENTORY = [{ sessionId: "sess-gateway-1", dispatchId: "dispatch-gateway-1", startedAt: "2026-09-28T00:00:00.000Z" }]

describe("the six steps run in order, and every one of them is on the record", () => {
  it("reports steps 1 to 6 for a clean pair, and never skips one", async () => {
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // A step that silently vanished from this list is a step that quietly stopped
    // happening, which is the only way a reader could tell.
    expect(outcome.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(outcome.steps.map((step) => step.name)).toEqual([
      "version_compatibility",
      "position_exchange",
      "stale_controller_rejection",
      "idempotent_resend",
      "session_inventory_comparison",
      "mark_unreconciled_for_review",
    ])
    // 1 through 3 PASS (they are decisions); 4 through 6 are REPORTED (they are
    // observations the response carries). Both states are load-bearing: a step 4 that
    // "passed" would be claiming a decision the responder does not make.
    expect(outcome.steps.slice(0, 3).map((step) => step.state)).toEqual(["passed", "passed", "passed"])
    expect(outcome.steps.slice(3).map((step) => step.state)).toEqual(["reported", "reported", "reported"])
  })

  it("step 1: a peer with no common protocol version is refused before ANY store is read", async () => {
    // Step 1 is a version comparison, and it comes first because the resend lists in
    // step 4 come out of queues: a queue read for a peer this mesh cannot talk to is
    // work done on the wrong side of a compatibility problem.
    const { reconciler, lease, unacknowledged, projections } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ peerProtocolVersions: [99] }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failedStep).toBe(1)
    expect(outcome.error.code).toBe("protocol.no_common_version")
    // And nothing was read except the lease, which is how the accepted epoch is
    // obtained — and no queue was touched at all.
    expect(unacknowledged.reads).toHaveLength(0)
    expect(projections.reads).toHaveLength(0)
    expect(lease.storesRead).toEqual(["lease"])
  })

  it("step 2: the positions the peer reported are what the resend lists are read from", async () => {
    const { reconciler, unacknowledged } = aReconciler()
    await reconciler.reconcile(
      reconcileRequestEnvelope({
        controllerLastAcknowledgedInboxSequence: 41,
        controllerLastAcknowledgedOutboxSequence: 17,
        activeSessionInventory: MATCHING_INVENTORY,
      }),
    )
    // The peer's acknowledged positions are the CURSOR, not a report: the resend list
    // is "what I still hold that you have not acknowledged seeing".
    expect(unacknowledged.reads.map((read) => [read.store, read.after])).toEqual([
      ["inbox", 41],
      ["outbox", 17],
    ])
  })

  it("step 3: a stale controller is refused, and no queue was read", async () => {
    const { reconciler, unacknowledged, projections, lease } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ controllerEpoch: EPOCH - 1 }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failedStep).toBe(3)
    expect(outcome.error.code).toBe("epoch.stale")
    // THE ordering assertion. A superseded controller's resend list is a set of
    // decisions taken against a projection that no longer exists; producing one and
    // then refusing would still have applied it somewhere.
    expect(unacknowledged.reads).toHaveLength(0)
    expect(projections.reads).toHaveLength(0)
    // And nothing was marked either, because the unreconciled set is a precondition a
    // successor's takeover is evaluated against, and a superseded controller must not be
    // able to change what a human is asked to inspect.
    expect(lease.unreconciledWrites).toHaveLength(0)
  })

  it("step 3: a controller ABOVE the lease is refused as unregistered, never as 'sort it out later'", async () => {
    const { reconciler, unacknowledged } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ controllerEpoch: EPOCH + 1 }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failedStep).toBe(3)
    // The message names the remedy, because "unregistered" alone sends an operator to
    // the wrong system.
    expect(outcome.error.code).toBe("epoch.unregistered")
    expect(outcome.error.message).toContain("takeover")
    expect(unacknowledged.reads).toHaveLength(0)
  })

  it("step 3: with NO lease held, there is no accepted epoch and nothing is reconciled", async () => {
    const { reconciler, unacknowledged } = aReconciler({ epoch: null })
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failedStep).toBeNull()
    expect(outcome.error.code).toBe("mesh.reconcile_no_lease")
    expect(outcome.error.message).toContain("no authority to acknowledge positions")
    expect(unacknowledged.reads).toHaveLength(0)
  })

  it("step 3: the epoch is read from the LEASE, and the lease is read FIRST", async () => {
    // "via M4.4's lease, not a second epoch rule": the right-hand side of the
    // comparison is a lease read, and the read happens before any other store.
    const { reconciler, lease, unacknowledged } = aReconciler()
    await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(lease.storesRead).toEqual(["lease"])
    expect(lease.reads[0]?.scope).toEqual(SCOPE)
    expect(unacknowledged.reads.map((read) => read.store)).toEqual(["inbox", "outbox"])
  })

  it("the reconciler cannot RAISE an epoch, because the port it holds has no takeover", () => {
    // The plan's guardrail, checked against the PORT's DECLARED members rather than
    // against its prose: a reconciler that could raise the epoch would make the epoch a
    // function of who reconciled first, which is the automatic election the milestone
    // forbids.
    const declared = [...(RECONCILER_SOURCE.match(/\.(?:heldLease|setUnreconciledNodeIds|takeover|claim|renew|release|writeLease)\(/g) ?? [])]
    expect([...new Set(declared)].sort()).toEqual([".heldLease(", ".setUnreconciledNodeIds("])
    // And the seam reaches no epoch-raising operation by ANY spelling.
    expect(RECONCILER_SOURCE).not.toMatch(/\.takeover\(/)
    expect(RECONCILER_SOURCE).not.toMatch(/\.writeLease\(/)
    expect(PORT_SOURCE).toMatch(/no `takeover` here/)
  })
})

describe("step 4: resends are ids, and the resend is idempotent", () => {
  it("reports the unacknowledged ids the peer's positions leave outstanding", async () => {
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.resendCommandIds).toEqual(["cmd-1", "cmd-2"])
    expect(outcome.response.resendEventIds).toEqual(["evt-1"])
  })

  it("running the same reconciliation twice produces the SAME lists, and converges", async () => {
    // Idempotent because the lists are ids: the receiver dedupes on `commandId` /
    // `eventId`, so a resend of something already applied converges onto the stored
    // result instead of appending a second thing that happened. The property is the
    // REPEAT, not the list — a resend that produced a different answer the second time
    // would be one whose convergence depends on having been asked only once.
    const { reconciler } = aReconciler()
    const first = await reconciler.reconcile(reconcileRequestEnvelope({ reconcileId: "rec-1", activeSessionInventory: MATCHING_INVENTORY }))
    const second = await reconciler.reconcile(reconcileRequestEnvelope({ reconcileId: "rec-1", activeSessionInventory: MATCHING_INVENTORY }))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.response.resendCommandIds).toEqual(first.response.resendCommandIds)
    expect(second.response.resendEventIds).toEqual(first.response.resendEventIds)
    expect(second.response.reconcileId).toBe(first.response.reconcileId)
  })

  it("bounds the lists to the seam's limit, and never above the protocol's own ARRAY_MAX", async () => {
    const lease = new FakeLease(EPOCH)
    const many = Array.from({ length: 500 }, (_, index) => `cmd-bulk-${index}`)
    const unacknowledged = new FakeUnacknowledged().seed(many, [])
    const projections = new FakeProjections().seed([{ dispatchId: "dispatch-gateway-1", sessionId: "sess-gateway-1" }])
    const reconciler = new MeshReconciler({ lease, unacknowledged, projections })
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The list crosses a wire to a peer that is, by definition at this point, not known
    // to be in sync — so it is bounded, and the bound is the SCHEMA's rather than a
    // number picked here.
    expect(outcome.response.resendCommandIds.length).toBeLessThanOrEqual(ARRAY_MAX)
    expect(RECONCILE_RESEND_LIMIT).toBe(ARRAY_MAX)
  })
})

describe("step 5: the session inventory is a diff, and never an action", () => {
  it("a session the controller has no dispatch for becomes an unreconciled entry", async () => {
    const { reconciler, lease } = aReconciler()
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.outcome).toBe("degraded")
    expect(outcome.response.unreconciled).toHaveLength(1)
    const entry = outcome.response.unreconciled[0]
    expect(entry?.reason).toBe("session_not_in_projection")
    expect(entry?.nodeId).toBe(WORKER)
    // The detail says what is different AND that it is not resolved, because a human
    // is the one who acts on it.
    expect(entry?.detail).toContain("sess-orphan")
    expect(entry?.detail).toContain("marks it for review and does not resolve it")
  })

  it("TWO sessions for one dispatch is the duplicate-work defect, and BOTH are left alone", async () => {
    // The controller recorded session A; the peer reports session B for the same
    // dispatch. Reporting it is the whole response: terminating either one is a
    // decision about a process the reporting node cannot see, and the plan's guardrail
    // is that reconciliation does not terminate anything.
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-second", dispatchId: "dispatch-gateway-1", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.unreconciled).toHaveLength(1)
    expect(outcome.response.unreconciled[0]?.reason).toBe("session_not_in_projection")
    // The detail names BOTH ids, because "there is a mismatch" is not actionable and
    // "dispatch X produced A here and B there" is.
    expect(outcome.response.unreconciled[0]?.detail).toContain("sess-gateway-1")
    expect(outcome.response.unreconciled[0]?.detail).toContain("sess-second")
    expect(outcome.response.unreconciled[0]?.detail).toContain("only someone who can see both nodes")
  })

  it("a difference NEVER becomes an action, and the response has nothing to act with", async () => {
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Every member of the response, by name. `unreconciled[]` is the only channel a
    // difference takes, and there is no `sessions`, no `terminated`, no `actions` and
    // no `adopted` for one to travel through.
    expect(Object.keys(outcome.response).sort()).toEqual([
      "acceptedControllerEpoch",
      "outcome",
      "reconcileId",
      "resendCommandIds",
      "resendEventIds",
      "unreconciled",
    ])
    // And the outcome value the reconciler hands back is a report, not a verdict about
    // a session: it carries the marked node ids and nothing that could act on them.
    expect(Object.keys(outcome).sort()).toEqual(["ok", "response", "steps", "unreconciledNodeIds"])
    expect(outcome.unreconciledNodeIds).toEqual([WORKER])
  })

  it("an EMPTY inventory converges, and marks nothing", async () => {
    const { reconciler, lease } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: [] }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // `converged` and not `degraded`: this node has no `SnapshotFallbackSource` wired,
    // so it cannot know whether it holds a re-base, and a policy that reported
    // `degraded` for an incomplete deployment would train an operator to read
    // `degraded` as "this node is not finished" rather than "these two disagree".
    expect(outcome.response.outcome).toBe("converged")
    expect(outcome.response.unreconciled).toEqual([])
    expect(outcome.unreconciledNodeIds).toEqual([])
    expect(lease.unreconciledWrites).toEqual([{ scope: SCOPE, nodeIds: Object.freeze([]) }])
  })

  it("a projection read that FAILS refuses the whole pass rather than reporting a short list", async () => {
    // A diff that skipped one unreadable dispatch and said "converged" for everything
    // else would be a clean bill of health for the part of the inventory nobody
    // looked at, and the operator reading it has no way to know.
    const { reconciler, projections, lease } = aReconciler()
    projections.failWith(storeUnavailable("dispatch projection"))
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe("mesh.reconcile_store_unavailable")
    expect(outcome.error.message).toContain("no way to know")
    // And it did not mark anything on the way out.
    expect(lease.unreconciledWrites).toHaveLength(0)
  })

  it("a queue read that fails refuses the pass too", async () => {
    const { reconciler, unacknowledged } = aReconciler()
    unacknowledged.failWith(storeUnavailable("command inbox"))
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe("mesh.reconcile_store_unavailable")
  })
})

describe("step 6: differences are MARKED, for a human, and nowhere else", () => {
  it("marks the peer as unreconciled on M4.4's lease, which is the takeover precondition", async () => {
    // This is the whole of what "mark unexplained differences for user review" means:
    // a fact the next takeover's user-inspection precondition is evaluated against.
    // It is a MARK and not an action, and it is the only write in the method.
    const { reconciler, lease } = aReconciler()
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        peerNodeId: OTHER_WORKER,
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.unreconciledNodeIds).toEqual([OTHER_WORKER])
    expect(lease.unreconciledWrites).toHaveLength(1)
    expect(lease.unreconciledWrites[0]?.scope).toEqual(SCOPE)
    expect(lease.unreconciledWrites[0]?.nodeIds).toEqual([OTHER_WORKER])
  })

  it("the write happens AFTER the epoch gate, so a stale controller cannot change it", async () => {
    const { reconciler, lease } = aReconciler()
    await reconciler.reconcile(reconcileRequestEnvelope({ controllerEpoch: EPOCH - 1 }))
    // A superseded controller must not be able to change what a successor is told it
    // has to inspect, because that list is a precondition a human then acts on.
    expect(lease.unreconciledWrites).toHaveLength(0)
  })

  it("the reconciler writes exactly ONCE per pass, and the write is the mark", async () => {
    const { reconciler, lease } = aReconciler()
    await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    // Once per pass, never twice in one: a second write in the method would be a
    // second thing a reconciliation could change, and the plan's step 6 names exactly
    // one — mark it, for a human.
    expect(lease.unreconciledWrites).toHaveLength(2)
    // And the ONLY lease operations the seam reaches are the read and that mark.
    const declared = [...(RECONCILER_SOURCE.match(/\.([a-zA-Z]+)\(/g) ?? [])]
    expect(declared).not.toContain(".takeover(")
    expect(declared).not.toContain(".claim(")
    expect(declared).not.toContain(".writeLease(")
  })

  it("the step 6 verdict says that nothing is adopted and nothing is terminated", async () => {
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // The operator-facing transcript, which is the artifact a person reads when the
    // mesh says it is degraded.
    const step6 = outcome.steps[5]
    expect(step6?.state).toBe("reported")
    expect(step6?.detail).toContain(WORKER)
    expect(step6?.detail).toContain("Nothing is adopted and nothing is terminated")
  })
})

describe("the seam refuses what it should, before reading anything", () => {
  it("a record that is not a reconciliation request is refused", async () => {
    const { reconciler, unacknowledged } = aReconciler()
    const outcome = await reconciler.reconcile({
      schemaVersion: 2,
      recordType: "mesh.heartbeat",
      messageId: "msg-1",
      correlationId: "hb-1",
      causation: null,
      senderNodeId: WORKER,
      recipientNodeId: WORKER,
      protocolVersion: 1,
      issuedAt: "2026-09-28T00:00:00.000Z",
      expiresAt: "2026-09-28T01:00:00.000Z",
      payload: {
        meshId: "mesh-release",
        nodeId: WORKER,
        observedAt: "2026-09-28T00:00:00.000Z",
        sequence: 1,
        liveness: "live",
        runtimeKinds: ["opencode"],
        capabilities: ["fs.read"],
        projectPathIds: ["path-release-1"],
        maxConcurrentSessions: 1,
        protocolVersions: [1],
        agentCount: 1,
        load: { activeSessions: 0, queuedSessions: 0 },
      },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe("mesh.reconcile_not_a_request")
    expect(outcome.error.message).toContain("mesh.heartbeat")
    expect(unacknowledged.reads).toHaveLength(0)
  })

  it("a record at a version this build cannot read is refused as a VERSION problem", async () => {
    const { reconciler } = aReconciler()
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ envelope: { schemaVersion: 99 } }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // M4-V: never coerced, never partially read, and never confused with a sender bug.
    expect(outcome.error.code).toBe("protocol.unsupported_schema_version")
  })

  it("an unversioned record is refused too, since it can never parse", async () => {
    const { reconciler } = aReconciler()
    const envelope = reconcileRequestEnvelope()
    delete (envelope as Record<string, unknown>).schemaVersion
    const outcome = await reconciler.reconcile(envelope)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe("protocol.unversioned_record")
  })

  it("a scope that cannot be parsed is refused rather than read against", async () => {
    const { reconciler, lease } = aReconciler()
    // The FAMILY refuses this first, at the one parse entry point, which is a better
    // answer than the reconciler's own scope check — but the property under test is
    // the same either way: nothing was read against a scope nobody verified.
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ runId: "not a run id" }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(["protocol.record_invalid", "mesh.reconcile_scope_unreadable"]).toContain(outcome.error.code)
    expect(lease.reads).toHaveLength(0)
  })

  it("a malformed dispatch id in the inventory refuses the pass, not just that entry", async () => {
    const { reconciler } = aReconciler()
    // The schema would have refused this on the way in, so this is a belt-and-braces
    // check; what it proves is that an unreadable dispatch does not become an EMPTY
    // diff, which would read as convergence.
    const outcome = await reconciler.reconcile(
      reconcileRequestEnvelope({
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "not a dispatch id", startedAt: "2026-09-28T00:00:00.000Z" }],
      }),
    )
    // The request itself does not parse, so the refusal is the registry's — which is
    // still a refusal, and the point is that it is not a `converged`.
    expect(outcome.ok).toBe(false)
  })
})

describe("the M4-S fallback is the same rule the SSE route uses", () => {
  it("attaches a `snapshotFallback` when the re-base source has one", async () => {
    const lease = new FakeLease(EPOCH)
    const unacknowledged = new FakeUnacknowledged()
    const projections = new FakeProjections()
    const snapshots = {
      fallbackFor: async (scope: ReplayScope) => ({
        ok: true as const,
        value: {
          snapshotFallback: {
            runId: scope.runId,
            lastAppliedSequence: 41,
            stateDigest: `sha256:${"a".repeat(64)}` as SnapshotFallback["stateDigest"],
          },
          state: {},
        },
      }),
    }
    const reconciler = new MeshReconciler({ lease, unacknowledged, projections, snapshots })
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: [] }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.snapshotFallback?.lastAppliedSequence).toBe(41)
    // No differences and a re-base offered: the peer is behind, not in conflict.
    expect(outcome.response.outcome).toBe("snapshot_required")
  })

  it("converges when the source is wired but holds no re-base, because the request carries no cursor", async () => {
    // The honest limit of this seam, and the reason the SSE route is where "your
    // cursor cannot be honoured" is decided: a `mesh.reconciliation.request` has no
    // cursor field, so this node cannot know that the peer is behind and therefore
    // cannot know that the peer NEEDS a re-base. What it can do is offer one whenever
    // it holds one, and report `converged` on the two things it CAN see — the
    // positions and the inventory. A node that reported `degraded` here would be
    // reporting a disagreement it has not looked for.
    const lease = new FakeLease(EPOCH)
    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: new FakeUnacknowledged(),
      // Seeded, so the inventory matches and the ONLY thing under test is the fallback.
      projections: new FakeProjections().seed([{ dispatchId: "dispatch-gateway-1", sessionId: "sess-gateway-1" }]),
      snapshots: { fallbackFor: async () => ({ ok: true as const, value: null }) },
    })
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.snapshotFallback).toBeUndefined()
    expect(outcome.response.outcome).toBe("converged")
  })

  it("a re-base that cannot be produced is a REFUSAL, not a silent 'converged'", async () => {
    // The difference from the case above: here the node was ASKED and its reader
    // failed. Reporting convergence over a re-base nobody could produce is the one
    // answer that hides a fault, and the source's own error is carried through so the
    // operator sees the store problem rather than a summary of it.
    const lease = new FakeLease(EPOCH)
    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: new FakeUnacknowledged(),
      projections: new FakeProjections().seed([{ dispatchId: "dispatch-gateway-1", sessionId: "sess-gateway-1" }]),
      snapshots: { fallbackFor: async () => storeUnavailable("snapshot store") },
    })
    const outcome = await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe("mesh.reconcile_store_unavailable")
  })

  it("asks the fallback source for the run's OWN scope, never an inferred one", async () => {
    const asked: { readonly projectId: string; readonly runId: string }[] = []
    const lease = new FakeLease(EPOCH)
    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: new FakeUnacknowledged(),
      projections: new FakeProjections(),
      snapshots: {
        fallbackFor: async (scope) => {
          asked.push(scope)
          return { ok: true as const, value: null }
        },
      },
    })
    await reconciler.reconcile(reconcileRequestEnvelope({ activeSessionInventory: MATCHING_INVENTORY }))
    // Convenience causes the cross-run disclosure: a reader that inferred the scope
    // from whatever it happened to be holding would hand a peer asking about run B the
    // state of run A.
    expect(asked).toEqual([{ projectId: PROJECT, runId: RUN }])
  })
})

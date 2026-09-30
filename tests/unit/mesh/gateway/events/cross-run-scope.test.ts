/**
 * M4.10 finding M4.10-S1 — the SSE gateway's cross-run disclosure.
 *
 * FOUNDED AND DEMONSTRATED at the M4.10 audit. Before the fix, `resume` used the
 * caller's `(projectId, runId)` for exactly ONE thing: filing the snapshot
 * fallback. The page itself was taken from `#retained` — a single window holding
 * every run this controller drives — and filtered only by `position > cursor`.
 *
 * So the sequence was:
 *
 *   1. node A (enrolled, pinned, in the mesh) authenticates to
 *      `GET /v1/mesh/events?projectId=P&runId=R` — a run it has no events for;
 *   2. the identity hook admits it (it is a legitimate node on a legitimate mesh);
 *   3. `scopeFromQuery` parses `P`/`R` and hands them over as `scope`;
 *   4. `resume(0, { scope })` returns the retained window from position 1 —
 *      including another run's `mesh.event` records VERBATIM, each of which
 *      carries a canonical `OrchestrationEvent` payload: the dispatch envelope
 *      (with its prompt), the session record, the approval.
 *
 * The disclosure is of the FULL event payload, not of an id. `session.prompt`'s
 * payload is `{ sessionId, prompt }` where `prompt` is a 64 KiB `largeTextSchema`,
 * and a `dispatch.proposed` payload carries the whole `dispatchEnvelope`. A node
 * that is a legitimate participant in one run could read another run's prompts.
 *
 * The route's own comment said the opposite — "a stream that did not say which run
 * it was could be answered with another run's state" — and the snapshot reader's
 * said the scope existed precisely to prevent "a cross-run disclosure caused
 * entirely by convenience". The disclosure was caused by exactly that convenience:
 * the scope was parsed, carried, and then only used where it was easy to use.
 *
 * THE SECOND HALF, and the one that is easier to miss: the fix is not only the
 * page filter. The HONOURABILITY FLOOR has to be computed over the client's own
 * window too. A global floor would answer `cursor_ahead`/`snapshot_required` for
 * a run whose events had all been evicted while another run's were retained — or,
 * worse in the other direction, tell a scoped client it was continuous when its
 * own window had been emptied underneath it. Both are the same undetectable gap
 * the snapshot fallback exists to refuse, and both are asserted below.
 */
import { describe, expect, it } from "vitest"
import { digestSchema, runIdSchema } from "../../../../../src/orchestration/identifiers.js"
import { MeshEventGateway } from "../../../../../src/mesh/gateway/events/index.js"
import type { EventStreamGateway, SnapshotFallbackSource } from "../../../../../src/mesh/gateway/events/index.js"
import {
  OTHER_PROJECT,
  OTHER_RUN,
  OTHER_WORKER,
  PROJECT,
  RUN,
  TestClock,
  WORKER,
  aMeshEvent,
  eventEnvelope,
} from "../fixtures.js"

async function publish(
  gateway: EventStreamGateway,
  overrides: Parameters<typeof aMeshEvent>[0],
): Promise<void> {
  const result = await gateway.publish(eventEnvelope(aMeshEvent(overrides)))
  if (!result.ok) throw new Error(`publish refused: ${result.error.code}`)
  if (!result.outcome.accepted) throw new Error(`publish suppressed: ${result.outcome.disposition}`)
}

/** Two runs on one gateway, each with its own source node and sequence. */
async function twoRuns(count = 3): Promise<MeshEventGateway> {
  const gateway = new MeshEventGateway({ now: new TestClock().now })
  for (let index = 1; index <= count; index += 1) {
    await publish(gateway, { eventId: `evt-mine-${index}`, localSequence: index, runSequence: index, runId: RUN })
    await publish(gateway, {
      eventId: `evt-theirs-${index}`,
      localSequence: index,
      runSequence: index,
      runId: OTHER_RUN,
      nodeId: OTHER_WORKER,
    })
  }
  return gateway
}

describe("M4.10-S1: a scoped resume returns only that run's events", () => {
  it("does not leak another run's events to a client that named a scope", async () => {
    const gateway = await twoRuns()
    const resumed = await gateway.resume(0, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    // The attack, restated as the assertion. Without the fix this is
    // `["evt-mine-1", ..., "evt-theirs-3"]` — every event on the gateway.
    expect(resumed.entries.map((entry) => entry.eventId)).toEqual(["evt-mine-1", "evt-mine-2", "evt-mine-3"])
    expect(resumed.entries.every((entry) => entry.runId === RUN)).toBe(true)
  })

  it("does not leak another PROJECT's events under a colliding run id", async () => {
    // Both halves of the scope, and the second is not decoration: nothing in the
    // protocol stops two projects minting the same `runId`, and matching on the
    // run alone would make a run id a mesh-wide capability.
    const gateway = new MeshEventGateway({ now: new TestClock().now })
    await publish(gateway, { eventId: "evt-p-1", localSequence: 1, runSequence: 1, projectId: PROJECT, runId: RUN })
    await publish(gateway, {
      eventId: "evt-q-1",
      localSequence: 1,
      runSequence: 1,
      projectId: OTHER_PROJECT,
      runId: RUN,
      nodeId: OTHER_WORKER,
    })

    const resumed = await gateway.resume(0, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    expect(resumed.entries.map((entry) => entry.eventId)).toEqual(["evt-p-1"])
  })

  it("reports the head the CLIENT can reach, not the global one", async () => {
    // The two runs interleave on the shared `position` axis, so `RUN`'s events sit
    // at 1, 3, 5 and `OTHER_RUN`'s at 2, 4, 6. A scoped client told `head: 6`
    // would be waiting for a position it can never be given, and its
    // `Last-Event-ID` arithmetic would be wrong.
    const gateway = await twoRuns()
    const resumed = await gateway.resume(0, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind === "resume" ? resumed.head : null).toBe(5)
    expect(gateway.head()).toBe(6)
  })

  it("refuses rather than serving an empty page when the client's OWN events aged out", async () => {
    // The second half of the fix, and the one a page filter alone does not close.
    // `OTHER_RUN` flooded the retention so that every one of `RUN`'s events was
    // evicted.
    //
    // The cursor is `3` and the retention floor is `4` — which is exactly the case
    // that makes this a test rather than a restatement. A GLOBAL floor says "the
    // entry after your cursor is still retained", hands back an empty page, and the
    // client concludes it is up to date having missed every event of its own run,
    // with nothing on the wire reporting it. A SCOPED floor, over a window that no
    // longer holds any of this run's events, cannot say that.
    const snapshots: SnapshotFallbackSource = {
      fallbackFor: async (scope) => ({
        ok: true,
        value: {
          snapshotFallback: {
            runId: scope.runId,
            lastAppliedSequence: 3,
            stateDigest: digestSchema.parse(`sha256:${"a".repeat(64)}`),
          },
          state: {},
        },
      }),
    }
    const build = async (withSnapshots: boolean): Promise<MeshEventGateway> => {
      const gateway = new MeshEventGateway({
        now: new TestClock().now,
        retentionMaxEvents: 3,
        ...(withSnapshots ? { snapshots } : {}),
      })
      for (let index = 1; index <= 3; index += 1) {
        await publish(gateway, { eventId: `evt-mine-${index}`, localSequence: index, runSequence: index, runId: RUN })
      }
      for (let index = 1; index <= 3; index += 1) {
        await publish(gateway, {
          eventId: `evt-theirs-${index}`,
          localSequence: index,
          runSequence: index,
          runId: OTHER_RUN,
          nodeId: OTHER_WORKER,
        })
      }
      return gateway
    }

    // The eviction, asserted. Without this the test would pass with or without the
    // fix, because a cursor below the GLOBAL floor is refused either way.
    const withoutSnapshots = await build(false)
    expect(withoutSnapshots.retained().some((entry) => entry.runId === RUN)).toBe(false)
    expect(withoutSnapshots.retained()).toHaveLength(3)
    expect(withoutSnapshots.oldestRetained()).toBe(4)

    // With no snapshot source, the honest answer is the refusal. A page — even an
    // empty one — would be the silent gap.
    const refused = await withoutSnapshots.resume(3, { scope: { projectId: PROJECT, runId: RUN } })
    expect(refused.kind).toBe("refused")
    if (refused.kind !== "refused") return
    expect(refused.reason).toBe("snapshot_unavailable")

    // And with a snapshot source, it is the RE-BASE, not the head and not a page.
    const rebase = await (await build(true)).resume(3, { scope: { projectId: PROJECT, runId: RUN } })
    expect(rebase.kind).toBe("snapshot_required")
    if (rebase.kind !== "snapshot_required") return
    expect(rebase.rebase.snapshotFallback.runId).toBe(RUN)
  })

  it("an UNSCOPED resume still sees every run, because the in-process reader may", async () => {
    // The other half of the contract. The filter is not "the gateway only ever
    // holds one run": the controller's own TUI and the fault harness read the
    // whole window, and they are inside the trust boundary. The NETWORK seam is
    // the one that cannot omit the scope, because `EventStreamRouteDependencies
    // .scopeOf` is required and returns a `Result` — a request without a parseable
    // scope is a 400 before `resume` is reached.
    const gateway = await twoRuns()
    const everything = await gateway.resume(0)
    expect(everything.kind).toBe("resume")
    if (everything.kind !== "resume") return
    expect(everything.entries).toHaveLength(6)
    expect(new Set(everything.entries.map((entry) => entry.runId))).toEqual(new Set([RUN, OTHER_RUN]))
  })

  it("does not disturb the retention bound: the page is still bounded", async () => {
    // A gateway configured with a SMALL retention, so the assertion is about the
    // page size rather than about the count of events the fixture happened to
    // publish. The filter narrows the page; it must not become the thing that
    // decides it, or a scoped client would get an unbounded one.
    const gateway = new MeshEventGateway({ now: new TestClock().now, retentionMaxEvents: 20 })
    for (let index = 1; index <= 40; index += 1) {
      await publish(gateway, {
        eventId: `evt-bounded-${index}`,
        localSequence: index,
        runSequence: index,
        runId: RUN,
        nodeId: WORKER,
      })
    }
    expect(gateway.retained()).toHaveLength(20)
    // From the RETENTION FLOOR, not from 0: forty events into a twenty-event window
    // means positions 1-20 are gone, and resuming from 0 is correctly refused
    // rather than answered with a page. This assertion is about the size of the
    // page the filter produces, so it asks for a cursor the window can honour.
    const resumed = await gateway.resume(20, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind === "resume" ? resumed.entries.length : null).toBe(20)
  })

  it("a scope with no events at all and no snapshot is refused, not answered with the head", async () => {
    // The boundary of the fix. A scope that has never had an event on this gateway
    // is not an error and not an empty page — it is a cursor the client cannot be
    // shown anything about, and the honest answer is the same refusal an aged-out
    // cursor gets.
    const gateway = await twoRuns(1)
    const resumed = await gateway.resume(0, { scope: { projectId: OTHER_PROJECT, runId: runIdSchema.parse("run-never-seen") } })
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.reason).toBe("snapshot_unavailable")
  })
})

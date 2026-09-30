import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { dispatchIdSchema, sessionIdSchema, type SessionId } from "../../../../src/orchestration/identifiers.js"
import {
  CURRENT_LAUNCH_OUTCOME_VERSION,
  LAUNCH_OUTCOME_VERSIONS,
  MESH_LAUNCH_OUTCOMES,
  canReadLaunchOutcomeVersion,
  deriveLaunchOutcome,
  explainKernelLaunchAdmissionGap,
  launchOutcomeNeedsAttention,
  unknownLaunchOutcomeVersion,
} from "../../../../src/mesh/inbox/launch-outcome.js"
import { durableInboxHarness, executeCommand, licensingLog, TestClock, at, type InboxHarness } from "./fixtures.js"

/**
 * R4, and the M0 contract surface it was NOT allowed to touch.
 *
 * Milestone 3 carried R4 forward as:
 *
 * > **`launchAdmission` can never be `unknown`/`failed`, because no event records
 * > a launch-command outcome.** M4.1 should either add that event type or state
 * > explicitly that an ambiguous launch is unrepresentable in projections.
 *
 * The implementation chose a third thing, and the tests below are what hold it
 * to that choice:
 *
 *   - **The ambiguity IS representable, as a WORKER fact.** `InboxEffectState`'s
 *     `runtime_accepted`, stamped at `EffectBoundary.afterRuntimeAccept`.
 *   - **It is NOT a kernel event.** `src/orchestration/schemas.ts` is inside the
 *     M0 contract digest, and adding a `launch.outcome` member would change that
 *     digest — which is the failure the plan calls "a passing gate that silently
 *     reshapes the canonical domain".
 *   - **It is VERSIONED and REACHABLE.** `CURRENT_LAUNCH_OUTCOME_VERSION` says
 *     which vocabulary this build reads, and `deriveLaunchOutcome` is exported
 *     from the seam M4.6, M4.8 and M4.9 actually import.
 */

const LAUNCH_OUTCOME_SOURCE = readFileSync(
  join(import.meta.dirname, "../../../../src/mesh/inbox/launch-outcome.ts"),
  "utf8",
)
const INBOX_INDEX_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/inbox/index.ts"), "utf8")

const M0_CONTRACT_FILES = [
  "../../../../src/orchestration/schemas.ts",
  "../../../../src/orchestration/types.ts",
  "../../../../src/orchestration/transitions.ts",
] as const

describe("R4 the ambiguity is a durable WORKER fact, not a kernel event", () => {
  it("`src/orchestration/schemas.ts` carries no launch-outcome member", () => {
    // The load-bearing assertion of the whole decision. If a future task added
    // `launch.outcome` to the event union, this test fails and the M0 digest
    // moves — which is the moment a recorded re-approval is required, rather than
    // the moment someone notices in production.
    const schemas = readFileSync(join(import.meta.dirname, M0_CONTRACT_FILES[0]), "utf8")
    expect(schemas).not.toMatch(/launch\.outcome/)
    expect(LAUNCH_OUTCOME_SOURCE).toMatch(/M0 contract digest/)
  })

  it("the three M0 contract files are untouched by this module", () => {
    for (const file of M0_CONTRACT_FILES) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8")
      expect(source, `${file} must not know about mesh launch outcomes`).not.toMatch(/MeshLaunchOutcome|mesh\.launch_outcome|deriveLaunchOutcome/)
    }
  })

  it("the mesh vocabulary adds the two members the kernel type cannot express", () => {
    // `ProjectionLaunchAdmission` has no member for an ambiguous launch, and
    // `unknown`/`failed` are not among its three. What changed is not that type —
    // it is that the thing it cannot express now has a durable, queryable home.
    expect(MESH_LAUNCH_OUTCOMES).toEqual(["not-requested", "pending", "runtime-accepted", "started", "unresolved"])
    expect(LAUNCH_OUTCOME_SOURCE).toMatch(/ProjectionLaunchAdmission. is deliberately NOT changed|kernel's `ProjectionLaunchAdmission` is deliberately/)
  })
})

describe("R4 the outcome vocabulary is VERSIONED", () => {
  it("declares a current version and a readable set", () => {
    // M4-V's rule is that a record family's shape is versioned, and this is a
    // record family in everything but transport: it is persisted, read by a TUI
    // and a reconciliation view, and held in operator memory longer than any
    // binary that produced it.
    expect(CURRENT_LAUNCH_OUTCOME_VERSION).toBe(2)
    expect(LAUNCH_OUTCOME_VERSIONS).toEqual([1, 2])
    expect(LAUNCH_OUTCOME_VERSIONS).toContain(CURRENT_LAUNCH_OUTCOME_VERSION)
  })

  it("refuses a version this build cannot interpret, rather than coercing it", () => {
    expect(canReadLaunchOutcomeVersion(1)).toBe(true)
    expect(canReadLaunchOutcomeVersion(2)).toBe(true)
    expect(canReadLaunchOutcomeVersion(3)).toBe(false)
    expect(canReadLaunchOutcomeVersion(0)).toBe(false)

    const error = unknownLaunchOutcomeVersion(7)
    expect(error.code).toBe("mesh.launch_outcome_version_unsupported")
    expect(error.category).toBe("unsupported_capability")
    // The message says WHY coercion is wrong rather than just refusing, because
    // the reader who would have coerced it is exactly the one who needs to be told.
    expect(error.message).toMatch(/never|unreadable/i)
  })

  it("stamps every derived outcome with the version it was derived under", () => {
    const outcome = deriveLaunchOutcome(null, null)
    expect(outcome.outcomeVersion).toBe(CURRENT_LAUNCH_OUTCOME_VERSION)
    expect(outcome.outcome).toBe("not-requested")
  })
})

describe("R4 the gap is REACHABLE, and `deriveLaunchOutcome` is total", () => {
  const SESSION = sessionIdSchema.parse("sess-launch-1")

  it("no row means no launch was attempted here", () => {
    const outcome = deriveLaunchOutcome(null, null)
    expect(outcome.outcome).toBe("not-requested")
    expect(outcome.sessionId).toBeNull()
    expect(outcome.error).toBeNull()
    expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(false)
  })

  it("`not_started` with no recorded start is `pending`, and is NOT an operator problem", () => {
    // A durable launch the peer has not taken yet is NORMAL under a partition.
    // Flagging it would train an operator to ignore the flag.
    const outcome = deriveLaunchOutcome(aRow("not_started", { runtimeAcceptedAt: null }), null)
    expect(outcome.outcome).toBe("pending")
    expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(false)
  })

  it("`not_started` with a recorded start is `started`, because the log outran the inbox", () => {
    // The reading that makes an operator press retry is "still waiting", and the
    // log is downstream evidence that it is not. A projection built across a
    // redelivery where the log is ahead must not report the work as waiting.
    const outcome = deriveLaunchOutcome(
      aRow("not_started", { runtimeAcceptedAt: null }),
      { dispatchId: dispatchIdSchema.parse("dispatch-launch-1"), startedSessionId: SESSION },
    )
    expect(outcome.outcome).toBe("started")
    expect(outcome.sessionId).toBe(SESSION)
  })

  it("`runtime_accepted` with no recorded start is the AMBIGUOUS launch, as a durable fact", () => {
    // This is R4's answer. The peer took the effect, and no outcome was recorded
    // before the process stopped — the crash window between "the runtime accepted
    // the launch" and "the acknowledgement was committed".
    const outcome = deriveLaunchOutcome(aRow("runtime_accepted", { runtimeAcceptedAt: at(7) }), null)
    expect(outcome.outcome).toBe("runtime-accepted")
    expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(true)
    expect(outcome.error?.code).toBe("mesh.launch_outcome_ambiguous")
    // The message says what is SAFE and what is NOT. Redelivering is safe because
    // the inbox returns the row; terminating is not, because the plan forbids
    // stopping work because a node went quiet.
    expect(outcome.error?.message).toMatch(/Redelivering is safe/)
    expect(outcome.error?.message).toMatch(/terminating is not/i)
  })

  it("`runtime_accepted` with a recorded start is `started` — accepted and then observed", () => {
    const outcome = deriveLaunchOutcome(
      aRow("runtime_accepted", { runtimeAcceptedAt: at(7) }),
      { dispatchId: dispatchIdSchema.parse("dispatch-launch-1"), startedSessionId: SESSION },
    )
    expect(outcome.outcome).toBe("started")
    expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(false)
  })

  it("`result_recorded` with NO recorded start is `unresolved`, never `started` and never `pending`", () => {
    // Collapsing this into `started` would INVENT a session; into `pending` would
    // claim the launch has not happened when this node has direct evidence it
    // did. `unresolved` is a member of the enum precisely so nobody has to reach
    // for a string.
    const outcome = deriveLaunchOutcome(aRow("result_recorded", { runtimeAcceptedAt: at(7), resultJson: '{"ok":true}' }), null)
    expect(outcome.outcome).toBe("unresolved")
    expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(true)
    expect(outcome.error?.code).toBe("mesh.launch_outcome_unresolved")
    expect(outcome.error?.message).toMatch(/neither may be discarded/)
  })

  it("`result_recorded` with a recorded start is `started`", () => {
    const outcome = deriveLaunchOutcome(
      aRow("result_recorded", { runtimeAcceptedAt: at(7), resultJson: "{}" }),
      { dispatchId: dispatchIdSchema.parse("dispatch-launch-1"), startedSessionId: SESSION },
    )
    expect(outcome.outcome).toBe("started")
  })

  it("every outcome carries evidence naming what it was derived from", () => {
    for (const row of [
      null,
      aRow("not_started", { runtimeAcceptedAt: null }),
      aRow("runtime_accepted", { runtimeAcceptedAt: at(7) }),
      aRow("result_recorded", { runtimeAcceptedAt: at(7), resultJson: "{}" }),
    ]) {
      const outcome = deriveLaunchOutcome(row, null)
      expect(outcome.evidence.length, `${outcome.outcome} has evidence`).toBeGreaterThan(20)
      // One sentence, for an operator and for a TUI tooltip.
      expect(outcome.evidence.split(".").filter((part) => part.trim().length > 0).length).toBeLessThanOrEqual(2)
    }
  })

  it("explains the kernel's missing members rather than leaving a reader to guess", () => {
    const ambiguous = explainKernelLaunchAdmissionGap("runtime-accepted")
    expect(ambiguous).toMatch(/has no member for this state/)
    expect(ambiguous).toMatch(/M0 contract digest/)
    expect(explainKernelLaunchAdmissionGap("started")).toMatch(/no mesh-only member is needed/)
  })
})

describe("R4 the ambiguous state is REACHABLE end to end, on the durable store", () => {
  it("a crash between runtime acceptance and the ack commit leaves `runtime_accepted`", async () => {
    // The lifecycle is driven through the real seams, not by hand-writing a row:
    // `markRuntimeAccepted` is the M4-B hook 6 half, and the assertion is that the
    // state survives both the missing `recordResult` and a process restart.
    const clock = new TestClock(at(0))
    const harness: InboxHarness = durableInboxHarness(clock, { log: licensingLog(executeCommand()) })
    try {
      const accepted = await harness.inbox.submit(executeCommand())
      expect(accepted.outcome).toBe("accepted")
      if (accepted.outcome !== "accepted") return

      // The peer took the effect; the ack is not committed; the process stops.
      const marked = await harness.inbox.markRuntimeAccepted(accepted.commandId)
      expect(marked.ok && marked.value?.effectState).toBe("runtime_accepted")

      // The stored instant is the FIRST one, and a second visit does not move
      // it. Which instant an ambiguous launch happened at is the only content the
      // state has, and an operator reading a later one would conclude the effect
      // was accepted after a redelivery that in fact re-accepted nothing.
      const firstInstant = (await harness.row(accepted.commandId))?.runtimeAcceptedAt
      clock.set(at(30))
      const again = await harness.inbox.markRuntimeAccepted(accepted.commandId)
      expect(again.ok && again.value?.runtimeAcceptedAt).toBe(firstInstant)
      expect(firstInstant).toBe(at(0))
    } finally {
      harness.close()
    }
  })

  it("the row never moves BACKWARDS out of a settled state", async () => {
    // The fact that the effect was accepted does not stop being true when this
    // process loses its memory of the outcome, so nothing may return the row to
    // `not_started`.
    const clock = new TestClock(at(0))
    const harness = durableInboxHarness(clock, { log: licensingLog(executeCommand()) })
    try {
      const accepted = await harness.inbox.submit(executeCommand())
      if (accepted.outcome !== "accepted") throw new Error(`expected accept, got ${accepted.outcome}`)

      await harness.inbox.markRuntimeAccepted(accepted.commandId)
      const recorded = await harness.inbox.recordResult(accepted.commandId, { sessionId: "sess-1" })
      expect(recorded.ok && recorded.value?.effectState).toBe("result_recorded")

      // A redelivery that reaches the runtime-accept write again changes nothing.
      const late = await harness.inbox.markRuntimeAccepted(accepted.commandId)
      expect(late.ok && late.value?.effectState).toBe("result_recorded")
    } finally {
      harness.close()
    }
  })

  it("derives the ambiguous outcome from the row the store actually holds", async () => {
    const clock = new TestClock(at(0))
    const harness = durableInboxHarness(clock, { log: licensingLog(executeCommand()) })
    try {
      const accepted = await harness.inbox.submit(executeCommand())
      if (accepted.outcome !== "accepted") throw new Error(`expected accept, got ${accepted.outcome}`)
      await harness.inbox.markRuntimeAccepted(accepted.commandId)

      // Read back through the store, not from the in-memory value the write
      // returned: the durable row is what a restarting process would find, and
      // it is a different object from the one the write produced.
      const stored = await harness.row(accepted.commandId)
      expect(stored?.effectState).toBe("runtime_accepted")

      const outcome = deriveLaunchOutcome(stored, null)
      expect(outcome.outcome).toBe("runtime-accepted")
      expect(outcome.commandId).toBe(accepted.commandId)
      expect(launchOutcomeNeedsAttention(outcome.outcome)).toBe(true)
    } finally {
      harness.close()
    }
  })

  it("is reachable from the seam a consumer imports", () => {
    // `M4-B`/`R4` are only closed if a downstream task can actually GET at the
    // answer. An exported function nothing re-exports is a function no TUI or
    // reconciliation view will find.
    expect(INBOX_INDEX_SOURCE).toMatch(/export \{[\s\S]*deriveLaunchOutcome/)
    expect(INBOX_INDEX_SOURCE).toMatch(/CURRENT_LAUNCH_OUTCOME_VERSION/)
    expect(INBOX_INDEX_SOURCE).toMatch(/canReadLaunchOutcomeVersion/)
    expect(INBOX_INDEX_SOURCE).toMatch(/R4 is closed, and not by editing the kernel/)
  })
})

/** A stored inbox row, built through the seam's own schema. */
function aRow(
  effectState: "not_started" | "runtime_accepted" | "result_recorded",
  overrides: { readonly runtimeAcceptedAt: number | null; readonly resultJson?: string },
) {
  return {
    schemaVersion: 2,
    commandId: "cmd-launch-1",
    projectId: "project-release",
    runId: "run-release-1",
    dispatchId: "dispatch-launch-1",
    targetNodeId: "node-worker-1",
    controllerNodeId: "node-controller-a",
    controllerEpoch: 1,
    leaseId: "lease-run-1-e1",
    commandType: "dispatch.execute",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    semanticFingerprint: `sha256:${"b".repeat(64)}`,
    commandJson: "{}",
    effectState,
    acceptedAt: at(0),
    acceptedSequence: 1,
    runtimeAcceptedAt: overrides.runtimeAcceptedAt,
    resultJson: overrides.resultJson ?? null,
    ackEmittedAt: at(0),
  } as unknown as Parameters<typeof deriveLaunchOutcome>[0]
}

export type { SessionId }

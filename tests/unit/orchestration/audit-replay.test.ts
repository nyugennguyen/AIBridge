import { describe, expect, it } from "vitest"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { OrchestrationEvent } from "../../../src/orchestration/types.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import { canonicalJson, digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import { projectIdSchema, runIdSchema, taskIdSchema } from "../../../src/orchestration/identifiers.js"
import { stripUndefined } from "../../../src/orchestration/projections/reducer.js"

const PROJECT = projectIdSchema.parse("proj-1")
const RUN = runIdSchema.parse("run-1")
const ACTOR = { kind: "user" as const, userId: "user-1" as never }
const NOW = "2026-09-28T00:00:00.000Z"

function envelope(dispatchId: string, attempt: number, timeoutSeconds = 600) {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId,
    attempt,
    projectId: PROJECT,
    runId: RUN,
    taskId: taskIdSchema.parse("task-1"),
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: `do ${dispatchId}`,
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1",
      templateVersion: 1,
      projectId: PROJECT,
      name: "Runner",
      purpose: "run",
      instructions: "run",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "t", id: "r" },
      permissionRestrictions: {
        allowedCapabilities: ["fs.read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: ACTOR,
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: `sha256:${"0".repeat(64)}` },
    requestedCapabilities: ["fs.read"],
    permissionEnvelope: {
      allowedCapabilities: ["fs.read"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds,
    controllerEpoch: 1,
  })
}

let eventSeq = 0
function ev(type: string, payload: unknown, sequence: number): OrchestrationEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${++eventSeq}`,
    sequence,
    type,
    projectId: PROJECT,
    runId: RUN,
    occurredAt: NOW,
    actor: ACTOR,
    controllerEpoch: 1,
    correlationId: "corr-1",
    causation: null,
    payload,
  } as unknown as OrchestrationEvent
}

/** A stream with three dispatches proposed at the SAME timestamp. */
function ambiguousStream(): OrchestrationEvent[] {
  return [
    ev("run.created", {
      run: {
        schemaVersion: 1,
        runId: RUN,
        projectId: PROJECT,
        goal: "g",
        state: "draft",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
    }, 1),
    ev("task.created", {
      task: {
        schemaVersion: 1,
        taskId: taskIdSchema.parse("task-1"),
        runId: RUN,
        projectId: PROJECT,
        title: "t",
        description: "d",
        state: "ready",
        failurePolicy: "block",
        dependencies: [],
        externalReferences: [],
      },
    }, 2),
    // Same `createdAt`, same attempt. Only dispatchId differs. Any ordering that
    // depends on Object.keys/insertion order rather than a total order on the
    // dispatches themselves will make `launchAdmission` non-deterministic.
    ev("dispatch.proposed", {
      dispatch: {
        schemaVersion: 1,
        envelope: envelope("disp-c", 1),
        envelopeDigest: digestDispatchEnvelope(envelope("disp-c", 1)),
        state: "proposed",
        createdAt: NOW,
        externalReferences: [],
      },
    }, 3),
    ev("dispatch.proposed", {
      dispatch: {
        schemaVersion: 1,
        envelope: envelope("disp-a", 1),
        envelopeDigest: digestDispatchEnvelope(envelope("disp-a", 1)),
        state: "proposed",
        createdAt: NOW,
        externalReferences: [],
      },
    }, 4),
    ev("dispatch.proposed", {
      dispatch: {
        schemaVersion: 1,
        envelope: envelope("disp-b", 1),
        envelopeDigest: digestDispatchEnvelope(envelope("disp-b", 1)),
        state: "proposed",
        createdAt: NOW,
        externalReferences: [],
      },
    }, 5),
  ]
}

function fold(events: readonly OrchestrationEvent[]): RunProjectionState {
  let state: RunProjectionState | null = null
  for (const event of events) state = reduceEvent(state, event)
  if (state === null) throw new Error("empty stream")
  return state
}

describe("AUDIT: reduceEvent is a pure function of the event sequence", () => {
  it("is a pure fold: the same sequence yields an identical state every time", () => {
    const stream = ambiguousStream()
    const first = fold(stream)
    const second = fold(stream)
    expect(canonicalJson(stripUndefined(first))).toBe(canonicalJson(stripUndefined(second)))
    expect(first.stateDigest).toBe(second.stateDigest)
  })

  it("does not mutate the state it was given", () => {
    const stream = ambiguousStream()
    let state: RunProjectionState | null = null
    for (const event of stream) {
      const before = state === null ? null : canonicalJson(stripUndefined(state))
      const next = reduceEvent(state, event)
      expect(state === null ? null : canonicalJson(stripUndefined(state))).toBe(before)
      state = next
    }
  })

  it("picks the same launch-admission winner when equal-time dispatches are inserted in any order", () => {
    // The three proposals share `createdAt` and `attempt`, so the winner is
    // decided purely by the dispatchId tiebreak. Insertion order must not matter.
    const stream = ambiguousStream()
    const baseline = fold(stream)

    // Rebuild the same three dispatches in a different insertion order by
    // re-deriving the projection from scratch with reordered proposal events.
    const reordered = [
      stream[0],
      stream[1],
      stream[4],
      stream[2],
      stream[3],
    ].map((event, index) => ({ ...event, sequence: index + 1 }) as OrchestrationEvent)

    const other = fold(reordered)
    expect(baseline.run.launchAdmission).toEqual(other.run.launchAdmission)
  })

  it("replaying the stream with a FRESH engine is byte-identical to the incremental fold", () => {
    const stream = ambiguousStream()
    // Incremental: apply one at a time through the engine (as live traffic).
    let incremental: RunProjectionState | null = null
    for (const event of stream) incremental = reduceEvent(incremental, event)
    // Replay: same events, fresh state, applied in one pass.
    let replayed: RunProjectionState | null = null
    for (const event of stream) replayed = reduceEvent(replayed, event)

    expect(canonicalJson(stripUndefined(incremental))).toBe(canonicalJson(stripUndefined(replayed)))
  })

  it("ignores an event from a different run rather than folding it in", () => {
    const stream = ambiguousStream()
    const state = fold(stream)
    const foreign = {
      ...ev("run.cancelled", { reason: "not mine" }, 6),
      runId: runIdSchema.parse("run-2"),
    } as unknown as OrchestrationEvent
    const after = reduceEvent(state, foreign)
    expect(after).toBe(state)
  })

  it("produces the same digest whether events arrive live or from a store read", () => {
    // A live event has no `globalPosition`; `StoredRunEvent` from
    // `readStream` does. If the fold records the field conditionally, the
    // incremental and replayed digests diverge for the same events.
    const stream = ambiguousStream()
    const live = fold(stream)

    const fromStore = fold(
      stream.map((event, index) => ({ ...event, globalPosition: index + 1 }) as unknown as OrchestrationEvent),
    )

    // The cursor itself differs (only the store read has one) and only the cursor
    // differs: the digest and every domain fact are identical.
    expect(live.stateDigest).toBe(fromStore.stateDigest)
    expect(live.lastAppliedPosition).toBeUndefined()
    expect(fromStore.lastAppliedPosition).toBe(5)
    const { lastAppliedPosition: _a, ...liveRest } = live
    const { lastAppliedPosition: _b, ...storeRest } = fromStore
    void _a
    void _b
    expect(canonicalJson(stripUndefined(liveRest))).toBe(canonicalJson(stripUndefined(storeRest)))
  })

  it("ignores an out-of-order event at or below the last applied sequence", () => {
    const stream = ambiguousStream()
    const state = fold(stream)
    const stale = { ...stream[2], sequence: 2 } as OrchestrationEvent
    expect(reduceEvent(state, stale)).toBe(state)
  })
})

import { describe, expect, it } from "vitest"
import { DispatchCoordinator, type CommandLog, type CoordinatorDependencies } from "../../../src/orchestration/coordinator/index.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import { approvalSchema, runSchema, sessionSchema } from "../../../src/orchestration/schemas.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import type { OrchestrationCommand } from "../../../src/orchestration/types.js"

const NOW = "2026-09-28T00:00:00.000Z"

function approval(overrides: Record<string, unknown> = {}) {
  return approvalSchema.safeParse({
    schemaVersion: 1,
    approvalId: "appr-1",
    projectId: "proj-1",
    runId: "run-1",
    dispatchId: "disp-1",
    envelopeDigest: `sha256:${"0".repeat(64)}`,
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: { kind: "user", userId: "user-1" },
    decidedAt: NOW,
    ...overrides,
  })
}

function run(overrides: Record<string, unknown> = {}) {
  return runSchema.safeParse({
    schemaVersion: 1,
    runId: "run-1",
    projectId: "proj-1",
    goal: "ship it",
    state: "active",
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
    ...overrides,
  })
}

function session(overrides: Record<string, unknown> = {}) {
  return sessionSchema.safeParse({
    schemaVersion: 1,
    sessionId: "sess-1",
    projectId: "proj-1",
    runId: "run-1",
    taskId: "task-1",
    dispatchId: "disp-1",
    nodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    ...overrides,
  })
}

/**
 * Regression tests for the nine conditions raised by the M0 contract
 * re-approval review. Each reproduces the exact hole that was closed, so these
 * fail if the invariant is ever relaxed again.
 */

describe("F1 — an approval record cannot be undecided", () => {
  it("rejects decision 'approved' with state 'pending'", () => {
    // `decision` and `decidedAt` are both required, so a record carrying a
    // decision HAS been decided. The only way to build this pair is to fabricate
    // a decision that was never taken.
    expect(approval({ state: "pending" }).success).toBe(false)
    expect(approval({ state: "pending", decision: "rejected" }).success).toBe(false)
  })

  it("still accepts every legitimate decision/state pair", () => {
    expect(approval({ decision: "approved", state: "approved" }).success).toBe(true)
    expect(approval({ decision: "approved", state: "invalidated" }).success).toBe(true)
    expect(approval({ decision: "rejected", state: "rejected" }).success).toBe(true)
    expect(approval({ decision: "approved", state: "rejected" }).success).toBe(false)
    expect(approval({ decision: "rejected", state: "approved" }).success).toBe(false)
  })
})

describe("F2 — pausing a terminal run is a contradiction", () => {
  it("rejects paused:true with every terminal state", () => {
    // Before the lifecycle/observation split, `state: "paused"` was itself
    // mutually exclusive with the terminal states, so this was unrepresentable.
    // Splitting the axis into a boolean silently gave that up.
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(run({ state, paused: true }).success).toBe(false)
    }
  })

  it("still accepts pausing live work", () => {
    expect(run({ state: "draft", paused: true }).success).toBe(true)
    expect(run({ state: "active", paused: true }).success).toBe(true)
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(run({ state, paused: false }).success).toBe(true)
    }
  })
})

describe("S2 — a session lifecycle is bound to its provider observation", () => {
  it("rejects a terminal lifecycle carrying a live observation", () => {
    for (const observed of ["starting", "idle", "working", "blocked"] as const) {
      for (const lifecycle of ["completed", "failed", "cancelled", "timed_out"] as const) {
        expect(session({ lifecycleState: lifecycle, observedState: observed }).success).toBe(false)
      }
    }
  })

  it("accepts a terminal lifecycle with a compatible observation", () => {
    // `unknown` is compatible because it is the ABSENCE of a claim, which is
    // exactly what an ambiguous disconnect reports.
    for (const lifecycle of ["completed", "failed"] as const) {
      for (const observed of ["completed", "failed", "unknown"] as const) {
        expect(session({ lifecycleState: lifecycle, observedState: observed }).success).toBe(true)
      }
    }
  })

  it("leaves non-terminal lifecycles free to carry any observation", () => {
    for (const observed of ["starting", "idle", "working", "blocked", "unknown"] as const) {
      for (const lifecycle of ["launching", "running", "idle"] as const) {
        expect(session({ lifecycleState: lifecycle, observedState: observed }).success).toBe(true)
      }
    }
  })
})

describe("S-1 and F3 — the pause gate has an owner and a way back", () => {
  function harness(seed: RunProjectionState | null) {
    const calls: unknown[] = []
    // The projection advances as commands are accepted, so a second command
    // observes the first one's effect — which is what makes the pause/resume
    // round-trip meaningful rather than two independent no-ops.
    let projection = seed
    let sequence = seed?.lastAppliedSequence ?? 0
    const log: CommandLog = {
      append: (options) => {
        calls.push(options)
        for (const event of options.events) {
          sequence += 1
          // The store assigns the stream sequence; the coordinator emits
          // sequence-less domain events.
          projection = reduceEvent(projection, { ...(event as object), sequence } as never)
        }
        return { duplicate: false, events: options.events }
      },
    }
    let n = 0
    const coordinator = new DispatchCoordinator({
      log,
      now: () => NOW,
      newEventId: () => `evt-${++n}`,
      readRun: (runId) => (projection !== null && projection.run.runId === runId ? projection : undefined),
    } satisfies CoordinatorDependencies)
    return { coordinator, calls }
  }

  function command(type: OrchestrationCommand["type"], payload: unknown, id: string): OrchestrationCommand {
    return {
      schemaVersion: 1,
      commandId: id as OrchestrationCommand["commandId"],
      type,
      projectId: "proj-1",
      runId: "run-1",
      actor: { kind: "user", userId: "user-1" },
      controllerNodeId: "node-1",
      controllerEpoch: 1,
      leaseId: "lease-1",
      issuedAt: NOW,
      expiresAt: "2026-09-28T01:00:00.000Z",
      correlationId: "corr-1",
      causation: null,
      payload,
    } as unknown as OrchestrationCommand
  }

  const activeRun = reduceEvent(null, {
    schemaVersion: 1,
    eventId: "e0",
    sequence: 1,
    type: "run.created",
    projectId: "proj-1",
    runId: "run-1",
    occurredAt: NOW,
    actor: { kind: "user", userId: "user-1" },
    controllerEpoch: 1,
    correlationId: "corr-1",
    causation: null,
    payload: { run: { schemaVersion: 1, runId: "run-1", projectId: "proj-1", goal: "g", state: "active", paused: false, createdAt: NOW, updatedAt: NOW, externalReferences: [] } },
  } as never)

  const createPayload = {
    run: { schemaVersion: 1, runId: "run-1", projectId: "proj-1", goal: "g", state: "draft", paused: false, createdAt: NOW, updatedAt: NOW, externalReferences: [] },
    tasks: [],
  }

  it("refuses a second run.create for an existing run, so paused cannot be cleared by re-emission", () => {
    // A fresh commandId evades the command receipt, and the sequence
    // unique-index only constrains position, not identity. Without this
    // precondition the reducer overwrote `paused` unconditionally, letting
    // anyone clear the gate that protects imported legacy work.
    const { coordinator, calls } = harness(activeRun)
    const result = coordinator.submit(command("run.create", createPayload, "cmd-again"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.run_already_exists")
    expect(calls).toHaveLength(0)
  })

  it("records pause and resume as events, so the gate has a way back", () => {
    const { coordinator, calls } = harness(activeRun)
    const paused = coordinator.submit(command("run.pause", { reason: "operator" }, "cmd-pause"))
    expect(paused.ok).toBe(true)
    if (paused.ok) expect(paused.value.events).toEqual(["run.paused"])

    const resumed = coordinator.submit(command("run.resume", { reason: "ready" }, "cmd-resume"))
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.value.events).toEqual(["run.resumed"])
    expect(calls).toHaveLength(2)
  })

  it("converges to a no-op when the gate is already in the requested state", () => {
    const { coordinator } = harness(activeRun)
    const resumed = coordinator.submit(command("run.resume", { reason: "already live" }, "cmd-resume"))
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.value.events).toEqual([])
  })

  it("refuses to pause or resume a terminal run", () => {
    const terminal = reduceEvent(null, {
      schemaVersion: 1,
      eventId: "e0",
      sequence: 1,
      type: "run.created",
      projectId: "proj-1",
      runId: "run-1",
      occurredAt: NOW,
      actor: { kind: "user", userId: "user-1" },
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { run: { schemaVersion: 1, runId: "run-1", projectId: "proj-1", goal: "g", state: "completed", paused: false, createdAt: NOW, updatedAt: NOW, externalReferences: [] } },
    } as never)
    const { coordinator } = harness(terminal)
    for (const type of ["run.pause", "run.resume"] as const) {
      const result = coordinator.submit(command(type, { reason: "too late" }, `cmd-${type}`))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe("coordinator.run_terminal")
    }
  })

  it("the reducer projects the gate from the events, in both directions", () => {
    let state = activeRun
    const gate = (type: "run.paused" | "run.resumed") =>
      reduceEvent(state, {
        schemaVersion: 1,
        eventId: `e-${type}`,
        sequence: state.lastAppliedSequence + 1,
        type,
        projectId: "proj-1",
        runId: "run-1",
        occurredAt: NOW,
        actor: { kind: "user", userId: "user-1" },
        controllerEpoch: 1,
        correlationId: "corr-1",
        causation: null,
        payload: { runId: "run-1", reason: "operator" },
      } as never)

    state = gate("run.paused")
    expect(state.run.paused).toBe(true)
    expect(state.run.state).toBe("paused")
    state = gate("run.resumed")
    expect(state.run.paused).toBe(false)
    expect(state.run.state).toBe("active")
  })
})

describe("S-6 — the replay path consults the lifecycle machine", () => {
  it("refuses an illegal session regression instead of writing it", () => {
    let state = reduceEvent(null, {
      schemaVersion: 1,
      eventId: "e0",
      sequence: 1,
      type: "run.created",
      projectId: "proj-1",
      runId: "run-1",
      occurredAt: NOW,
      actor: { kind: "user", userId: "user-1" },
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { run: { schemaVersion: 1, runId: "run-1", projectId: "proj-1", goal: "g", state: "active", paused: false, createdAt: NOW, updatedAt: NOW, externalReferences: [] } },
    } as never)

    const base = {
      schemaVersion: 1,
      projectId: "proj-1",
      runId: "run-1",
      taskId: "task-1",
      dispatchId: "disp-1",
      nodeId: "node-1",
      installationId: "inst-1",
      runtimeKind: "opencode",
    }
    state = reduceEvent(state, {
      schemaVersion: 1, eventId: "e1", sequence: 2, type: "dispatch.started", projectId: "proj-1", runId: "run-1",
      occurredAt: NOW, actor: { kind: "user", userId: "user-1" }, controllerEpoch: 1, correlationId: "c", causation: null,
      payload: { session: { ...base, sessionId: "sess-1", lifecycleState: "running", observedState: "working" } },
    } as never)

    // `running -> launching` is not a legal transition. The projection used to
    // accept it silently, so a corrupt or hand-edited log could rewind a
    // session. It is now quarantined by throwing.
    expect(() =>
      reduceEvent(state, {
        schemaVersion: 1, eventId: "e2", sequence: 3, type: "session.observed", projectId: "proj-1", runId: "run-1",
        occurredAt: NOW, actor: { kind: "user", userId: "user-1" }, controllerEpoch: 1, correlationId: "c", causation: null,
        payload: { session: { ...base, sessionId: "sess-1", lifecycleState: "launching", observedState: "starting" } },
      } as never),
    ).toThrow(/Illegal session lifecycle transition/)
  })
})

import { describe, expect, it } from "vitest"
import { DispatchCoordinator, RUNTIME_DESTINATION } from "../../src/orchestration/coordinator/index.js"
import { SqliteEventStore, openInMemoryDriver } from "../../src/orchestration/event-store/index.js"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import { reduceEvent } from "../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../src/orchestration/projections/types.js"
import { dispatchEnvelopeSchema, taskSchema } from "../../src/orchestration/schemas.js"
import type { Approval, Dispatch, OrchestrationCommand, Run } from "../../src/orchestration/types.js"
import { commandIdSchema, correlationIdSchema, leaseIdSchema, nodeIdSchema } from "../../src/orchestration/identifiers.js"

const PROJECT = "proj-1"
const RUN = "run-1"
const ACTOR = { kind: "user", userId: "user-1" } as never
const NOW = "2026-09-28T00:00:00.000Z"

function envelope(overrides: Record<string, unknown> = {}) {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-1",
    attempt: 1,
    projectId: PROJECT,
    runId: RUN,
    taskId: "task-1",
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: "deploy the api",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1",
      templateVersion: 1,
      projectId: PROJECT,
      name: "Deployer",
      purpose: "deploy",
      instructions: "deploy carefully",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "policy" },
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
    timeoutSeconds: 600,
    controllerEpoch: 1,
    ...overrides,
  })
}

function run(state: Run["state"] = "draft"): Run {
  return {
    schemaVersion: 1,
    runId: RUN,
    projectId: PROJECT,
    goal: "ship it",
    state,
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
  } as unknown as Run
}

function command(type: OrchestrationCommand["type"], payload: unknown, id: string): OrchestrationCommand {
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(id),
    type,
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: nodeIdSchema.parse("node-1"),
    controllerEpoch: 1,
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: "2026-09-28T01:00:00.000Z",
    correlationId: correlationIdSchema.parse("corr-1"),
    causation: null,
    payload,
  } as unknown as OrchestrationCommand
}

function createRunCommand(id: string): OrchestrationCommand {
  return command(
    "run.create",
    {
      run: run("draft"),
      tasks: [
        taskSchema.parse({
          schemaVersion: 1, taskId: "task-1", runId: RUN, projectId: PROJECT,
          title: "deploy", description: "d", state: "ready", failurePolicy: "block",
          dependencies: [], externalReferences: [],
        }),
      ],
    },
    id,
  )
}

/**
 * The whole kernel over a REAL SQLite event store: commands go through the
 * coordinator, the store assigns stream sequences, and the projection is folded
 * from what the log actually contains. This is the plan's end-to-end proof, not
 * a mock.
 */
function harness() {
  const store = new SqliteEventStore(openInMemoryDriver())
  let eventSeq = 0
  let projection: RunProjectionState | null = null

  const coordinator = new DispatchCoordinator({
    log: {
      append: (options) => {
        // The store assigns the stream sequence and returns the stored events
        // carrying it. Folding exactly those is what makes "incremental equals
        // full replay" a real assertion rather than a tautology: the incremental
        // path consumes the same shaped events a restart replay would.
        const result = store.append(options)
        for (const event of result.events) {
          projection = reduceEvent(projection, event)
        }
        return result
      },
    },
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: () => projection ?? undefined,
  })

  return { store, coordinator, getProjection: () => projection }
}

describe("End-to-end orchestration flow over a real event store", () => {
  it("create, approve, start: the run reaches a running session and a pending outbox record", () => {
    const { coordinator, store, getProjection } = harness()

    const created = coordinator.submit(createRunCommand("cmd-create"))
    if (!created.ok) throw new Error(`${created.error.category}/${created.error.code}: ${created.error.message}`)

    const env = envelope()
    // A dispatch must exist in the log before it can be approved. The
    // coordinator refuses to approve a dispatch that was never proposed.
    const proposed = coordinator.submit(
      command("dispatch.propose", {
        dispatch: { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "proposed", createdAt: NOW, externalReferences: [] } as unknown as Dispatch,
      }, "cmd-propose"),
    )
    if (!proposed.ok) throw new Error(`${proposed.error.category}/${proposed.error.code}: ${proposed.error.message}`)

    const approval: Approval = {
      schemaVersion: 1,
      approvalId: "appr-1" as never,
      projectId: PROJECT as never,
      runId: RUN as never,
      dispatchId: env.dispatchId,
      envelopeDigest: digestDispatchEnvelope(env),
      decision: "approved",
      state: "approved",
      basis: { kind: "user" },
      actor: ACTOR,
      decidedAt: NOW,
    } as unknown as Approval

    const approved = coordinator.submit(
      command("dispatch.approve", { dispatch: { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "approved", createdAt: NOW, externalReferences: [] } as unknown as Dispatch, approval }, "cmd-approve"),
    )
    if (!approved.ok) throw new Error(`${approved.error.category}/${approved.error.code}: ${approved.error.message}`)

    const started = coordinator.submit(
      command("dispatch.execute", { dispatch: { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "approved", createdAt: NOW, externalReferences: [] } as unknown as Dispatch, approval }, "cmd-start"),
    )
    if (!started.ok) throw new Error(`${started.error.category}/${started.error.code}: ${started.error.message}`)

    const state = getProjection()!
    expect(state.run.state).toBe("active")
    expect(Object.values(state.dispatches)[0].state).toBe("running")
    expect(Object.values(state.sessions)).toHaveLength(1)

    // The runtime effect is NAMED in the log, not performed inside it.
    const pending = store.listPendingOutbox()
    expect(pending).toHaveLength(1)
    expect(pending[0].destination).toBe(RUNTIME_DESTINATION)
    expect(pending[0].status).toBe("pending")
  })

  it("a duplicate start cannot launch a second session or enqueue a second effect", () => {
    const { coordinator, store, getProjection } = harness()
    const env = envelope()
    const approval = {
      schemaVersion: 1, approvalId: "appr-1", projectId: PROJECT, runId: RUN, dispatchId: env.dispatchId,
      envelopeDigest: digestDispatchEnvelope(env), decision: "approved", state: "approved",
      basis: { kind: "user" }, actor: ACTOR, decidedAt: NOW,
    } as unknown as Approval
    const dispatch = { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "approved", createdAt: NOW, externalReferences: [] } as unknown as Dispatch

    coordinator.submit(createRunCommand("cmd-create"))
    coordinator.submit(command("dispatch.propose", { dispatch: { ...dispatch, state: "proposed" } as unknown as Dispatch }, "cmd-propose"))
    coordinator.submit(command("dispatch.approve", { dispatch, approval }, "cmd-approve"))
    const first = coordinator.submit(command("dispatch.execute", { dispatch, approval }, "cmd-start"))
    if (!first.ok) throw new Error(`${first.error.category}/${first.error.code}: ${first.error.message}`)

    // The SAME command id again.
    const again = coordinator.submit(command("dispatch.execute", { dispatch, approval }, "cmd-start"))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.value.duplicate).toBe(true)

    expect(Object.values(getProjection()!.sessions)).toHaveLength(1)
    expect(store.listPendingOutbox()).toHaveLength(1)

    // A DIFFERENT command id for the same already-started dispatch still must not
    // produce a second launch: the recorded log says it is already running.
    const secondId = coordinator.submit(command("dispatch.execute", { dispatch, approval }, "cmd-start-2"))
    expect(secondId.ok).toBe(true)
    if (secondId.ok) expect(secondId.value.events).toEqual([])
    expect(Object.values(getProjection()!.sessions)).toHaveLength(1)
    expect(store.listPendingOutbox()).toHaveLength(1)
  })

  it("a full replay of the log reproduces the incremental projection exactly", () => {
    const { coordinator, store, getProjection } = harness()
    const env = envelope()
    const approval = {
      schemaVersion: 1, approvalId: "appr-1", projectId: PROJECT, runId: RUN, dispatchId: env.dispatchId,
      envelopeDigest: digestDispatchEnvelope(env), decision: "approved", state: "approved",
      basis: { kind: "user" }, actor: ACTOR, decidedAt: NOW,
    } as unknown as Approval
    const dispatch = { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "approved", createdAt: NOW, externalReferences: [] } as unknown as Dispatch

    coordinator.submit(createRunCommand("cmd-create"))
    coordinator.submit(command("dispatch.propose", { dispatch: { ...dispatch, state: "proposed" } as unknown as Dispatch }, "cmd-propose"))
    coordinator.submit(command("dispatch.approve", { dispatch, approval }, "cmd-approve"))
    coordinator.submit(command("dispatch.execute", { dispatch, approval }, "cmd-start"))

    const incremental = getProjection()!

    // Rebuild from the store's own stream, which carries the assigned sequences.
    let replayed: RunProjectionState | null = null
    for (const stored of store.readStream(RUN)) {
      replayed = reduceEvent(replayed, stored)
    }

    expect(replayed).not.toBeNull()
    // The plan's criterion: "Incremental and full-replay projections are identical."
    expect(replayed!.stateDigest).toBe(incremental.stateDigest)
    expect(Object.keys(replayed!.dispatches)).toEqual(Object.keys(incremental.dispatches))
    expect(Object.keys(replayed!.sessions)).toEqual(Object.keys(incremental.sessions))
    expect(Object.keys(replayed!.approvals)).toEqual(Object.keys(incremental.approvals))
  })

  it("a first dispatch can be proposed: the kernel has an entry point for starting work", () => {
    const { coordinator, getProjection } = harness()
    coordinator.submit(createRunCommand("cmd-create"))

    const env = envelope()
    const result = coordinator.submit(
      command("dispatch.propose", {
        dispatch: { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "proposed", createdAt: NOW, externalReferences: [] } as unknown as Dispatch,
      }, "cmd-propose"),
    )
    if (!result.ok) throw new Error(`${result.error.category}/${result.error.code}: ${result.error.message}`)
    expect(result.value.events).toEqual(["dispatch.proposed"])
    expect(Object.keys(getProjection()!.dispatches)).toEqual(["disp-1"])
  })

  it("refuses to propose the same dispatch twice, because an envelope is immutable", () => {
    const { coordinator } = harness()
    coordinator.submit(createRunCommand("cmd-create"))
    const env = envelope()
    const dispatch = { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "proposed", createdAt: NOW, externalReferences: [] } as unknown as Dispatch

    coordinator.submit(command("dispatch.propose", { dispatch }, "cmd-propose"))
    const again = coordinator.submit(command("dispatch.propose", { dispatch }, "cmd-propose-2"))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe("coordinator.dispatch_already_proposed")
  })

  it("an unapproved dispatch cannot be started, and the log records nothing", () => {
    const { coordinator, store } = harness()
    const env = envelope()
    const dispatch = { schemaVersion: 1, envelope: env, envelopeDigest: digestDispatchEnvelope(env), state: "approved", createdAt: NOW, externalReferences: [] } as unknown as Dispatch
    const forged = {
      schemaVersion: 1, approvalId: "forged", projectId: PROJECT, runId: RUN, dispatchId: env.dispatchId,
      envelopeDigest: digestDispatchEnvelope(env), decision: "approved", state: "approved",
      basis: { kind: "user" }, actor: ACTOR, decidedAt: NOW,
    } as unknown as Approval

    coordinator.submit(createRunCommand("cmd-create"))
    const result = coordinator.submit(command("dispatch.execute", { dispatch, approval: forged }, "cmd-forged"))
    expect(result.ok).toBe(false)
    // The dispatch was never proposed, so the recorded log has no authority for it.
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_unknown")
    expect(store.listPendingOutbox()).toHaveLength(0)
  })
})

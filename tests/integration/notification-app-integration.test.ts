/**
 * End-to-end Application-Level Integration Tests for Advisory Notifications (P5 row 4).
 *
 * Verifies end-to-end through the Fastify app (`POST /orchestration/commands`):
 * 1. A real `roundtable.outcome_recorded` event committed to the log feeds the notification
 *    consumer via the post-append event path (`attachNotificationConsumerToCommandLog`) and
 *    produces a `roundtable_outcome` notification in the store.
 * 2. A real `roundtable_required` dispatch refusal (communication policy requiring a closed
 *    roundtable before execution dispatch) notifies the consumer via the route refusal path
 *    and produces a `run_blocked` notification in the store.
 * 3. The advisory-only invariant holds end-to-end: notification failures (throwing adapters)
 *    never affect, delay, or alter the HTTP responses or orchestration outcomes returned to callers.
 */

import { describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { createApp } from "../../src/server/app.js"
import { attachNotificationConsumerToCommandLog } from "../../src/bridge.js"
import {
  createNotificationBus,
  createNotificationStore,
  createOrchestrationNotificationConsumer,
  notificationEnvelopeSchema,
  type NotificationAdapter,
  type NotificationBus,
  type NotificationEnvelope,
  type NotificationStore,
  type NotificationTimestamp,
} from "../../src/notifications/index.js"
import {
  DispatchCoordinator,
  type CommandLog,
} from "../../src/orchestration/coordinator/index.js"
import {
  RoundtableRepository,
  type RoundtableOutcome,
} from "../../src/orchestration/roundtable/index.js"
import { CharterRepository } from "../../src/orchestration/charter/repository.js"
import { CharterProposalLifecycle } from "../../src/orchestration/charter/proposal.js"
import { SAFETY_FLOOR } from "../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../src/orchestration/policy/immutable-core.js"
import { SqliteEventStore } from "../../src/orchestration/event-store/index.js"
import {
  computeCharterSnapshotDigest,
  dispatchEnvelopeSchema,
  orchestrationCommandSchema,
} from "../../src/orchestration/schemas.js"
import type { Charter } from "../../src/orchestration/charter/types.js"
import type {
  Approval,
  Dispatch,
  DispatchEnvelope,
  OrchestrationCommand,
  OrchestrationEvent,
} from "../../src/orchestration/types.js"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  eventIdSchema,
  installationIdSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  userIdSchema,
} from "../../src/orchestration/identifiers.js"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import { reduceEvent } from "../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../src/orchestration/projections/types.js"
import { testConfig, FakeOpencodeClient, FakeTaskGraphSyncer, InMemoryJobStore } from "./fixtures.js"
import { JobManager } from "../../src/jobs/manager.js"
import { CallbackReporter } from "../../src/callback/reporter.js"

// ============================================================================
// Test Constants & Fixture Helpers
// ============================================================================

const TEST_PROJECT_ID = "app"
const TEST_RUN_ID = "run-notif-app"
const TEST_TASK_ID = "task-notif-1"
const CHAIR_NODE = "node-chair"
const WORKER_NODE = "node-worker"
const OPERATOR_TOKEN = "test-operator-secret"
const NOW = "2026-10-14T12:00:00.000Z"

function makeTestCharter(objectionRequiredBefore: readonly string[] = []): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId: projectIdSchema.parse(TEST_PROJECT_ID),
    version: 1,
    purpose: "Testing notification integration end-to-end",
    globalRules: ["rule 1"],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: [...objectionRequiredBefore],
      verbosity: "normal" as const,
      mustStopAndAsk: [],
      objectionMustContain: ["rationale"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "chair_decides" as const,
      budgetScope: "shared" as const,
    },
    roleCatalog: [{ roleId: "implementer", version: 1 }],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}` as const,
    author: "human" as const,
    capturedAt: NOW,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function makeDispatchEnvelope(capabilities: readonly string[] = ["deploy"]): DispatchEnvelope {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-notif-1",
    projectId: TEST_PROJECT_ID,
    runId: TEST_RUN_ID,
    taskId: TEST_TASK_ID,
    attempt: 1,
    targetNodeId: CHAIR_NODE,
    installationId: "inst-1",
    runtimeKind: "opencode" as const,
    projectPathId: "path-app",
    prompt: "Execute canary release",
    requestedCapabilities: [...capabilities],
    permissionEnvelope: {
      allowedCapabilities: [...capabilities],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "implementer",
      templateVersion: 1,
      projectId: TEST_PROJECT_ID,
      name: "Implementer",
      purpose: "Code implementation",
      instructions: "Implement safely",
      requiredCapabilities: [...capabilities],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "policy" },
      permissionRestrictions: {
        allowedCapabilities: [...capabilities],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: { kind: "user" as const, userId: "usr-operator" },
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: {
      manifestDigest: `sha256:${"1".repeat(64)}`,
      references: [],
    },
    dependencies: [],
    timeoutSeconds: 300,
    controllerEpoch: 1,
  })
}

function makeCommand<T extends OrchestrationCommand["type"]>(
  type: T,
  payload: Extract<OrchestrationCommand, { type: T }>["payload"],
  commandId = `cmd-${type.replace(/\./g, "-")}-1`,
  actorOverrides?: OrchestrationCommand["actor"],
): Extract<OrchestrationCommand, { type: T }> {
  const defaultActor: OrchestrationCommand["actor"] =
    type === "dispatch.approve" || type === "charter.revise" || type === "roundtable.inject_human"
      ? { kind: "user", userId: userIdSchema.parse("usr-operator") }
      : { kind: "session", sessionId: sessionIdSchema.parse("sess-coord") }
  const base = {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(commandId),
    projectId: projectIdSchema.parse(TEST_PROJECT_ID),
    runId: runIdSchema.parse(TEST_RUN_ID),
    actor: actorOverrides ?? defaultActor,
    controllerNodeId: nodeIdSchema.parse(CHAIR_NODE),
    controllerEpoch: 1,
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: "2026-10-14T13:00:00.000Z",
    correlationId: correlationIdSchema.parse(`corr-${commandId}`),
    causation: null,
    type,
    payload,
  }
  return orchestrationCommandSchema.parse(base) as Extract<OrchestrationCommand, { type: T }>
}

function makeApprovedDispatch(envelope: DispatchEnvelope): Dispatch {
  return {
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state: "approved",
    createdAt: NOW,
    externalReferences: [],
  }
}

function makeApproval(envelope: DispatchEnvelope): Approval {
  return {
    schemaVersion: 1,
    approvalId: "appr-notif-1" as never,
    projectId: projectIdSchema.parse(TEST_PROJECT_ID),
    runId: runIdSchema.parse(TEST_RUN_ID),
    dispatchId: envelope.dispatchId,
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: { kind: "user", userId: userIdSchema.parse("usr-operator") },
    decidedAt: NOW,
  }
}

interface TestAppHarness {
  readonly app: FastifyInstance
  readonly store: NotificationStore
  readonly bus: NotificationBus
  readonly calls: NotificationEnvelope[]
  readonly roundtables: RoundtableRepository
  readonly charters: CharterRepository
}

function setupTestHarness(options: {
  readonly objectionRequiredBefore?: readonly string[]
  readonly adapterShouldThrow?: boolean
}): TestAppHarness {
  const clock = { now: () => NOW as NotificationTimestamp }
  const store = createNotificationStore({ clock })
  const calls: NotificationEnvelope[] = []

  const testAdapter: NotificationAdapter = {
    id: "test-recorder",
    async deliver(envelope) {
      if (options.adapterShouldThrow) {
        throw new Error("simulated sink delivery failure")
      }
      calls.push(envelope)
      return { delivered: true, notificationId: envelope.notificationId }
    },
  }

  const bus = createNotificationBus({
    store,
    adapters: [testAdapter],
    clock,
  })
  const consumer = createOrchestrationNotificationConsumer(bus)

  const sqliteStore = SqliteEventStore.createInMemory()
  let projection: RunProjectionState | null = null

  // Base in-memory command log backed by real SqliteEventStore
  const baseLog: CommandLog = {
    append(opts) {
      const result = sqliteStore.append(opts)
      for (const rawEvent of result.events) {
        const event = (rawEvent && typeof rawEvent === "object" && "event" in rawEvent && rawEvent.event)
          ? rawEvent.event
          : rawEvent
        projection = reduceEvent(projection, event as OrchestrationEvent)
      }
      return result
    },
  }

  // Initialize run and task in sqlite store
  const initRunCmd = makeCommand(
    "run.create",
    {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Testing notification integration",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
      tasks: [
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse(TEST_TASK_ID),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Deploy canary release",
          description: "Task under test",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
      ],
    },
    "cmd-init-run",
  )
  baseLog.append({
    command: initRunCmd,
    events: [
      {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("evt-run"),
        type: "run.created",
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        runId: runIdSchema.parse(TEST_RUN_ID),
        occurredAt: NOW,
        actor: { kind: "node" as const, nodeId: nodeIdSchema.parse(CHAIR_NODE) },
        controllerEpoch: 1,
        correlationId: correlationIdSchema.parse("corr-init"),
        causation: null,
        payload: {
          run: {
            schemaVersion: 1,
            runId: runIdSchema.parse(TEST_RUN_ID),
            projectId: projectIdSchema.parse(TEST_PROJECT_ID),
            goal: "Testing notification integration",
            state: "active",
            paused: false,
            createdAt: NOW,
            updatedAt: NOW,
            externalReferences: [],
          },
        },
      },
      {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("evt-task"),
        type: "task.created",
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        runId: runIdSchema.parse(TEST_RUN_ID),
        occurredAt: NOW,
        actor: { kind: "node" as const, nodeId: nodeIdSchema.parse(CHAIR_NODE) },
        controllerEpoch: 1,
        correlationId: correlationIdSchema.parse("corr-init"),
        causation: null,
        payload: {
          task: {
            schemaVersion: 1,
            taskId: taskIdSchema.parse(TEST_TASK_ID),
            runId: runIdSchema.parse(TEST_RUN_ID),
            projectId: projectIdSchema.parse(TEST_PROJECT_ID),
            title: "Deploy canary release",
            description: "Task under test",
            state: "ready",
            failurePolicy: "block",
            dependencies: [],
            externalReferences: [],
          },
        },
      },
    ],
  })
  // Subscribe notification consumer to the post-append event path
  const commandLog = attachNotificationConsumerToCommandLog(baseLog, consumer)

  const roundtables = new RoundtableRepository()
  const charters = new CharterRepository()
  const charter = makeTestCharter(options.objectionRequiredBefore ?? [])
  charters.registerCharter(charter)
  const charterProposals = new CharterProposalLifecycle({ safetyFloor: SAFETY_FLOOR })

  let eventSeq = 0
  const coordinator = new DispatchCoordinator({
    log: commandLog,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId: string) => (projection?.run.runId === runId ? projection : undefined),
    roundtables,
    charters,
    charterProposals,
    safetyFloor: SAFETY_FLOOR,
  })


  const config = testConfig()
  const app = createApp({
    config,
    bearerToken: "secret",
    operatorToken: OPERATOR_TOKEN,
    jobManager: new JobManager(new InMemoryJobStore()),
    opencodeClient: new FakeOpencodeClient(),
    callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
    monitorSession: async () => undefined,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    orchestration: { coordinator },
    notificationStore: store,
    notificationBus: bus,
    notificationConsumer: consumer,
  })

  return { app, store, bus, calls, roundtables, charters }
}

describe("App-Level Notification Integration (End-to-End)", () => {
  it("proves a REAL roundtable.outcome_recorded produces a notification end-to-end through the app", async () => {
    const harness = setupTestHarness({})
    const { app, store, calls } = harness
    const discussionId = "disc-deliberation-001"

    // 1. Open a roundtable deliberation session via POST /orchestration/commands
    const openRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand(
        "roundtable.open",
        {
          roundtable: {
            id: discussionId,
            runId: runIdSchema.parse(TEST_RUN_ID),
            taskId: taskIdSchema.parse(TEST_TASK_ID),
            subject: "Review deployment risk",
            mode: "sequential",
            chairNodeId: nodeIdSchema.parse(CHAIR_NODE),
            members: [
              { nodeId: nodeIdSchema.parse(CHAIR_NODE), roleId: "chair" },
              { nodeId: nodeIdSchema.parse(WORKER_NODE), roleId: "reviewer" },
            ],
            state: "open",
          },
        },
        "cmd-open-1",
      ),
    })
    expect(openRes.statusCode).toBe(200)
    expect(openRes.json().ok).toBe(true)

    // 2. Post to the discussion
    const postRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-1",
            discussionId,
            seq: 1,
            authorNodeId: nodeIdSchema.parse(WORKER_NODE),
            authorRoleId: "reviewer",
            kind: "proposal",
            body: "Propose canary rollout with 5% traffic weight",
            createdAt: NOW,
          },
        },
        "cmd-post-1",
        { kind: "node", nodeId: nodeIdSchema.parse(WORKER_NODE) },
      ),
    })
    expect(postRes.statusCode).toBe(200)
    expect(postRes.json().ok).toBe(true)

    // 3. Close the roundtable deliberation with an advisory outcome
    const recommendationText = "Proceed with canary traffic weight of 5%"
    const closeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand(
        "roundtable.close",
        {
          discussionId,
          outcome: {
            summary: "Consensus reached on canary traffic limits",
            recommendation: recommendationText,
            addressedObjections: [],
            unresolvedObjections: [],
          },
        },
        "cmd-close-1",
      ),
    })
    expect(closeRes.statusCode).toBe(200)
    expect(closeRes.json().ok).toBe(true)
    expect(closeRes.json().value.events).toEqual(["roundtable.outcome_recorded"])

    // 4. Verify that the post-append event path fed the notification consumer
    const entries = store.entries()
    expect(entries.length).toBeGreaterThan(0)

    const outcomeNotification = entries.find((e) => e.envelope.category === "roundtable_outcome")
    expect(outcomeNotification).toBeDefined()
    expect(outcomeNotification?.envelope.severity).toBe("info")
    expect(outcomeNotification?.envelope.reasonCode).toBe("outcome_recorded")
    expect(outcomeNotification?.envelope.dedupeKey).toBe(`roundtable_outcome:${discussionId}`)
    expect(outcomeNotification?.envelope.summary).toContain(discussionId)
    expect(outcomeNotification?.envelope.summary).toContain(recommendationText)

    // Verify adapter delivery
    expect(calls.some((call) => call.category === "roundtable_outcome")).toBe(true)
    const callEnvelope = calls.find((c) => c.category === "roundtable_outcome")!
    expect(notificationEnvelopeSchema.safeParse(callEnvelope).success).toBe(true)
  })

  it("proves a REAL roundtable_required dispatch refusal produces a notification end-to-end through the app", async () => {
    // Charter requires closed roundtable for "deploy" actions
    const harness = setupTestHarness({ objectionRequiredBefore: ["deploy"] })
    const { app, store, calls } = harness

    // Prepare dispatch and approval
    const envelope = makeDispatchEnvelope(["deploy"])
    const initialDispatch: Dispatch = {
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: "proposed",
      createdAt: NOW,
      externalReferences: [],
    }

    // Propose dispatch via POST /orchestration/commands
    const proposeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand("dispatch.propose", { dispatch: initialDispatch }, "cmd-disp-propose"),
    })
    expect(proposeRes.statusCode).toBe(200)
    expect(proposeRes.json().ok).toBe(true)

    // Approve dispatch via POST /orchestration/commands
    const approval = makeApproval(envelope)
    const approvedDispatch: Dispatch = {
      ...initialDispatch,
      state: "approved",
    }
    const approveRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: makeCommand("dispatch.approve", { dispatch: approvedDispatch, approval }, "cmd-disp-approve"),
    })
    expect(approveRes.json().ok).toBe(true)

    // Submit dispatch.execute WITHOUT a closed roundtable for task-notif-1
    const executeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand(
        "dispatch.execute",
        {
          dispatch: approvedDispatch,
          approval,
        },
        "cmd-disp-exec",
      ),
    })

    // The coordinator's roundtable gate refused dispatch.execute!
    expect(executeRes.statusCode).toBe(200)
    const result = executeRes.json()
    expect(result.ok).toBe(false)
    expect(result.error.category).toBe("policy_denied")
    expect(result.error.code).toBe("roundtable_required")
    expect(result.error.message).toContain("roundtable_required")

    // Verify that the route refusal path fed the notification consumer
    const entries = store.entries()
    const refusalNotification = entries.find((e) => e.envelope.category === "run_blocked")
    expect(refusalNotification).toBeDefined()
    expect(refusalNotification?.envelope.severity).toBe("attention")
    expect(refusalNotification?.envelope.reasonCode).toBe("roundtable_required")
    expect(refusalNotification?.envelope.dedupeKey).toContain("roundtable_required")
    expect(refusalNotification?.envelope.runId).toBe(TEST_RUN_ID)
    expect(refusalNotification?.envelope.taskId).toBe(TEST_TASK_ID)
    expect(refusalNotification?.envelope.summary).toContain("roundtable required")

    // Verify adapter delivery
    expect(calls.some((c) => c.category === "run_blocked")).toBe(true)
    const delivered = calls.find((c) => c.category === "run_blocked")!
    expect(notificationEnvelopeSchema.safeParse(delivered).success).toBe(true)
  })

  it("proves the advisory invariant: sink failures never affect HTTP command outcomes", async () => {
    // Adapter throws on delivery
    const harness = setupTestHarness({
      objectionRequiredBefore: ["deploy"],
      adapterShouldThrow: true,
    })
    const { app, store } = harness

    const envelope = makeDispatchEnvelope(["deploy"])
    const initialDispatch: Dispatch = {
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: "proposed",
      createdAt: NOW,
      externalReferences: [],
    }
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand("dispatch.propose", { dispatch: initialDispatch }, "cmd-sink-propose"),
    })

    const approval = makeApproval(envelope)
    const approvedDispatch: Dispatch = {
      ...initialDispatch,
      state: "approved",
    }
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: makeCommand("dispatch.approve", { dispatch: approvedDispatch, approval }, "cmd-sink-approve"),
    })

    // Execute refusal with broken adapter
    const executeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand(
        "dispatch.execute",
        {
          dispatch: approvedDispatch,
          approval,
        },
        "cmd-failing-sink",
      ),
    })

    // HTTP response is still 200 with the exact same error; sink error was absorbed silently (ADR 0007 §17)
    expect(executeRes.statusCode).toBe(200)
    expect(executeRes.json().ok).toBe(false)
    expect(executeRes.json().error.code).toBe("roundtable_required")

    // The store still owns its record (N14)
    expect(store.entries().length).toBeGreaterThan(0)
    expect(harness.bus.counters().adapterErrors).toBeGreaterThan(0)
  })
})

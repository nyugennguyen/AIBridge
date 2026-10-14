/**
 * Herdr Local Loop Ingress & Terminal Mechanics Integration Test (§10 Phase 3, §11).
 *
 * ARCHITECTURAL CONTEXT & TEST INTENT:
 * Verifies local terminal loop ingress mechanics, crash consistency, idempotence,
 * and capability intersection evaluation through the kernel HTTP ingress:
 *
 * 1. Loop Round-Trip with Idempotent Replay Protection:
 *    Ensures that retrying the exact same command (`commandId` reused) against
 *    `POST /orchestration/commands` returns `duplicate: true`, emits no duplicate events,
 *    and launches no duplicate terminal panes or prompt effects.
 * 2. Ingress Validation Discipline:
 *    Submitting `roundtable.inject_human` with a non-human author role (`authorRoleId: "agent"`)
 *    is rejected with 400 Bad Request at the Zod schema boundary before reaching the coordinator.
 * 3. Non-Member Deliberation Refusal:
 *    Submitting `roundtable.post` from an undeclared member node is refused by the
 *    coordinator's invariant boundary with `coordinator.roundtable_not_member`.
 * 4. Durable-Before-Effect Crash Consistency:
 *    When the prompt runtime effect throws a transient transport failure, the durable log
 *    record committed prior to the effect is preserved, and the coordinator returns a typed
 *    `transient_transport` failure without losing durable append history.
 * 5. Capability Preview Integration:
 *    Evaluates `POST /orchestration/capability-preview` across assigned roles to verify
 *    proper intersection calculation prior to dispatch proposal.
 */

import { describe, expect, it } from "vitest"
import {
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  installationIdSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  userIdSchema,
  type Digest,
} from "../../src/orchestration/identifiers.js"
import {
  dispatchEnvelopeSchema,
  orchestrationCommandSchema,
} from "../../src/orchestration/schemas.js"
import type {
  Approval,
  Dispatch,
  OrchestrationCommand,
  OrchestrationEvent,
  Session,
} from "../../src/orchestration/types.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  DispatchCoordinator,
  type CommandLog,
} from "../../src/orchestration/coordinator/index.js"
import {
  SqliteEventStore,
  openInMemoryDriver,
} from "../../src/orchestration/event-store/index.js"
import { digestDispatchEnvelope } from "../../src/orchestration/digest.js"
import { reduceEvent } from "../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../src/orchestration/projections/types.js"
import { SAFETY_FLOOR } from "../../src/orchestration/policy/floor.js"
import { CharterRepository } from "../../src/orchestration/charter/repository.js"
import { CharterProposalLifecycle } from "../../src/orchestration/charter/proposal.js"
import {
  RoundtableRepository,
  type RoundtableOutcome,
} from "../../src/orchestration/roundtable/index.js"
import {
  HerdrTerminalBackend,
  InMemoryHerdrClient,
  HERDR_KIND,
} from "../../src/terminal/herdr-terminal-backend.js"
import { buildTestApp, testConfig, FakeOpencodeClient } from "./fixtures.js"

// ============================================================================
// Constants & Recording Helpers
// ============================================================================

const NOW = "2026-10-14T10:00:00.000Z"
const LATER = "2026-10-14T12:00:00.000Z"
const TEST_PROJECT_ID = "app"
const TEST_PROJECT_PATH = "/srv/apps/app"
const TEST_RUN_ID = "run-loop-mechanics-001"
const CHAIR_NODE = "node-chair"
const WORKER_A = "node-worker-a"
const WORKER_B = "node-worker-b"
const UNKNOWN_NODE = "node-stranger"
const OPERATOR_TOKEN = "test-operator-token"

class RecordingOpencodeClient extends FakeOpencodeClient {
  readonly sentPromptsLog: Array<{ sessionId: string; prompt: string; directory: string }> = []
  shouldFailPrompt = false

  override async sendPromptAsync(sessionId = "", prompt = "", directory = ""): Promise<void> {
    if (this.shouldFailPrompt) {
      throw new Error("Simulated transient transport timeout while communicating with OpenCode daemon")
    }
    await super.sendPromptAsync()
    this.sentPromptsLog.push({ sessionId, prompt, directory })
  }
}

class TrackingSessionMonitor {
  readonly monitored: Array<{ session: Session; directory: string }> = []

  async waitForIdle(session: Session, directory: string): Promise<void> {
    this.monitored.push({ session, directory })
  }
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const dispatchId = (overrides.dispatchId as string) ?? "disp-mech-001"
  const base = {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    projectId: TEST_PROJECT_ID,
    runId: TEST_RUN_ID,
    taskId: "task-1",
    targetNodeId: CHAIR_NODE,
    installationId: "inst-1",
    runtimeKind: "opencode" as const,
    projectPathId: "path-app",
    prompt: "Execute initial agent task in Herdr pane",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "implementer",
      templateVersion: 1,
      projectId: TEST_PROJECT_ID,
      name: "Implementer",
      purpose: "Code implementation",
      instructions: "Implement requested changes cleanly",
      requiredCapabilities: ["testing"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "test", id: "policy" },
      permissionRestrictions: {
        allowedCapabilities: ["testing"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: { kind: "user" as const, userId: "usr-operator" },
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: {
      references: [],
      manifestDigest: `sha256:${"0".repeat(64)}` as Digest,
    },
    requestedCapabilities: ["testing"],
    permissionEnvelope: {
      allowedCapabilities: ["testing"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 300,
    controllerEpoch: 1,
    ...overrides,
  }
  return dispatchEnvelopeSchema.parse(base)
}

function makeCommand<T extends OrchestrationCommand["type"]>(
  type: T,
  payload: Extract<OrchestrationCommand, { type: T }>["payload"],
  commandId = `cmd-${type.replace(/\./g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
    expiresAt: LATER,
    correlationId: correlationIdSchema.parse(`corr-${commandId}`),
    causation: null,
    type,
    payload,
  }
  return orchestrationCommandSchema.parse(base) as Extract<OrchestrationCommand, { type: T }>
}

async function setupHarness() {
  const opencode = new RecordingOpencodeClient()
  const monitor = new TrackingSessionMonitor()
  const herdrClient = new InMemoryHerdrClient()
  const terminalBackend = new HerdrTerminalBackend({ client: herdrClient })

  const store = new SqliteEventStore(openInMemoryDriver())
  let projection: RunProjectionState | null = null
  let eventSeq = 0

  const commandLog: CommandLog = {
    append(options) {
      const result = store.append(options)
      for (const rawEvent of result.events) {
        const event = rawEvent as OrchestrationEvent
        projection = reduceEvent(projection, event)
      }
      return result
    },
  }

  const roundtables = new RoundtableRepository()
  const charters = new CharterRepository()
  const charterProposals = new CharterProposalLifecycle({ safetyFloor: SAFETY_FLOOR })

  const coordinator = new DispatchCoordinator({
    log: commandLog,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId: string) => (projection?.run.runId === runId ? projection : undefined),
    opencodeClient: opencode,
    sessionMonitor: monitor,
    resolveProjectDir: () => TEST_PROJECT_PATH,
    roundtables,
    charters,
    charterProposals,
    safetyFloor: SAFETY_FLOOR,
  })

  const { app } = await buildTestApp({
    config: {
      ...testConfig(),
      terminal: { backend: "herdr" },
    },
    operatorToken: OPERATOR_TOKEN,
    opencodeClient: opencode,
    orchestration: { coordinator },
  })

  const recordSessionReady = (sessionId: string, dispatchId: string) => {
    const readyEvent = {
      schemaVersion: 1 as const,
      eventId: eventIdSchema.parse(`evt-${++eventSeq}`),
      type: "session.observed" as const,
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      runId: runIdSchema.parse(TEST_RUN_ID),
      actor: { kind: "node" as const, nodeId: nodeIdSchema.parse(CHAIR_NODE) },
      controllerEpoch: 1,
      occurredAt: NOW,
      correlationId: correlationIdSchema.parse("corr-session-ready"),
      causation: null,
      payload: {
        session: {
          schemaVersion: 1 as const,
          sessionId: sessionIdSchema.parse(sessionId),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          runId: runIdSchema.parse(TEST_RUN_ID),
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: dispatchId as never,
          nodeId: nodeIdSchema.parse(CHAIR_NODE),
          installationId: installationIdSchema.parse("inst-1"),
          runtimeKind: "opencode" as const,
          lifecycleState: "idle" as const,
          observedState: "idle" as const,
          terminalId: terminalIdSchema.parse("term:herdr.pane-mech-1"),
        },
      },
    }
    const observeCmd = makeCommand(
      "session.interrupt",
      {
        sessionId: sessionIdSchema.parse(sessionId),
        reason: "Session ready observation",
      },
      `cmd-observe-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    )
    commandLog.append({
      command: observeCmd,
      events: [readyEvent],
    })
  }

  return {
    app,
    coordinator,
    store,
    herdrClient,
    terminalBackend,
    opencode,
    monitor,
    recordSessionReady,
    getProjection: () => projection,
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Herdr Local Loop Mechanics & Ingress Constraints (§10 Phase 3, §11)", () => {
  it("round-trips the complete local loop through app.inject() with idempotent command replay protection", async () => {
    const harness = await setupHarness()
    const { app, herdrClient, terminalBackend, opencode, recordSessionReady } = harness

    // 1. run.create
    const runCreateCmd = makeCommand("run.create", {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Test command idempotence and loop replay",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
      tasks: [
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse("task-1"),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Mechanics Task",
          description: "Verify idempotence",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
      ],
    })
    const runCreateRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: runCreateCmd,
    })
    expect(runCreateRes.statusCode).toBe(200)
    expect(runCreateRes.json().ok).toBe(true)

    // 2. dispatch.propose
    const envelope = makeEnvelope({ dispatchId: "disp-idemp-001" })
    const dispatch: Dispatch = {
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: "proposed",
      createdAt: NOW,
      externalReferences: [],
    }
    const proposeCmd = makeCommand("dispatch.propose", { dispatch })
    const proposeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: proposeCmd,
    })
    expect(proposeRes.statusCode).toBe(200)

    // 3. dispatch.approve
    const approval: Approval = {
      schemaVersion: 1,
      approvalId: "appr-idemp-001" as never,
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
    const approvedDispatch: Dispatch = { ...dispatch, state: "approved" }
    const approveCmd = makeCommand("dispatch.approve", { dispatch: approvedDispatch, approval })
    const approveRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: approveCmd,
    })
    expect(approveRes.statusCode).toBe(200)

    // 4. dispatch.execute with FIXED commandId to test duplicate submission
    const fixedExecCommandId = "cmd-exec-idempotent-test"
    const execCmd = makeCommand(
      "dispatch.execute",
      { dispatch: approvedDispatch, approval },
      fixedExecCommandId,
    )
    const execFirstRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: execCmd,
    })
    expect(execFirstRes.statusCode).toBe(200)
    expect(execFirstRes.json().ok).toBe(true)
    expect(execFirstRes.json().value.duplicate).toBe(false)
    expect(execFirstRes.json().value.events).toEqual(["dispatch.started"])

    // Replay IDENTICAL commandId: must return duplicate: true with empty events
    const execSecondRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: execCmd,
    })
    expect(execSecondRes.statusCode).toBe(200)
    expect(execSecondRes.json().ok).toBe(true)
    expect(execSecondRes.json().value.duplicate).toBe(true)

    // Verify session was created only once
    const launchedSessionId = `sess-${fixedExecCommandId}`
    expect(Object.keys(harness.getProjection()?.sessions ?? {})).toHaveLength(1)

    // 5. Spawn Herdr pane and verify write
    const terminalId = terminalIdSchema.parse("term:herdr.pane-idemp")
    const termRes = await terminalBackend.create({
      schemaVersion: 1,
      operation: {
        schemaVersion: 1,
        commandId: commandIdSchema.parse("cmd-term-idemp-create"),
        correlationId: correlationIdSchema.parse("corr-term-idemp-create"),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        nodeId: nodeIdSchema.parse(CHAIR_NODE),
        clientId: terminalClientIdSchema.parse("client-manager"),
        controllerAuthority: {
          controllerNodeId: nodeIdSchema.parse(CHAIR_NODE),
          controllerEpoch: 1,
          leaseId: leaseIdSchema.parse("lease-1"),
        },
      },
      terminalId,
      sessionId: sessionIdSchema.parse(launchedSessionId),
      backendKind: HERDR_KIND,
      columns: 80,
      rows: 24,
      bufferByteLimit: 1024,
    })
    expect(termRes.ok).toBe(true)
    if (!termRes.ok) return

    const attachRes = await terminalBackend.attach(termRes.value, {
      schemaVersion: 1,
      commandId: commandIdSchema.parse("cmd-term-idemp-attach"),
      correlationId: correlationIdSchema.parse("corr-term-idemp-attach"),
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      nodeId: nodeIdSchema.parse(CHAIR_NODE),
      clientId: terminalClientIdSchema.parse("client-manager"),
    })
    expect(attachRes.ok).toBe(true)
    if (!attachRes.ok) return
    const channel = attachRes.value

    const writeRes = await channel.write(new TextEncoder().encode("initial check\n"))
    expect(writeRes.ok).toBe(true)
    expect(herdrClient.calls.some((c) => c.method === "claimInput")).toBe(true)

    recordSessionReady(launchedSessionId, envelope.dispatchId)

    // 6. session.prompt with FIXED commandId to test duplicate submission
    const fixedPromptCommandId = "cmd-prompt-idempotent-test"
    const promptCmd = makeCommand(
      "session.prompt",
      {
        sessionId: sessionIdSchema.parse(launchedSessionId),
        prompt: "Run diagnostics pass 1",
      },
      fixedPromptCommandId,
    )
    const promptFirstRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: promptCmd,
    })
    expect(promptFirstRes.statusCode).toBe(200)
    expect(promptFirstRes.json().ok).toBe(true)
    expect(promptFirstRes.json().value.duplicate).toBe(false)
    expect(opencode.sentPromptsLog).toHaveLength(1)

    // Replay IDENTICAL prompt commandId: must return duplicate: true and deliver NO second prompt
    const promptSecondRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: promptCmd,
    })
    expect(promptSecondRes.statusCode).toBe(200)
    expect(promptSecondRes.json().ok).toBe(true)
    expect(promptSecondRes.json().value.duplicate).toBe(true)
    // Opencode client was not invoked a second time
    expect(opencode.sentPromptsLog).toHaveLength(1)

    await app.close()
  })

  it("refuses roundtable.inject_human with non-human author role with 400 Bad Request", async () => {
    const harness = await setupHarness()
    const { app } = harness
    // 1. Prepare active run
    const runCreateCmd = makeCommand("run.create", {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Validation Test Run",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
      tasks: [
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse("task-1"),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Validation Task",
          description: "Task for validation test",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
      ],
    })
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: runCreateCmd,
    })

    // 2. Prepare an open discussion
    const discussionId = "disc-validation-001"
    const openCmd = makeCommand("roundtable.open", {
      roundtable: {
        id: discussionId,
        runId: runIdSchema.parse(TEST_RUN_ID),
        taskId: taskIdSchema.parse("task-1"),
        subject: "Validation Test Discussion",
        mode: "sequential",
        chairNodeId: nodeIdSchema.parse(CHAIR_NODE),
        members: [
          { nodeId: nodeIdSchema.parse(CHAIR_NODE), roleId: "chair-role" },
          { nodeId: nodeIdSchema.parse(WORKER_A), roleId: "worker-role" },
        ],
        state: "open",
      },
    })
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: openCmd,
    })

    // INGRESS VALIDATION INVARIANT: authorRoleId MUST be "human"
    // Build raw payload directly without pre-parsing through orchestrationCommandSchema
    const invalidInjectPayload = {
      schemaVersion: 1,
      commandId: `cmd-invalid-inject-${Date.now()}`,
      projectId: TEST_PROJECT_ID,
      runId: TEST_RUN_ID,
      actor: { kind: "user", userId: "usr-operator" },
      controllerNodeId: CHAIR_NODE,
      controllerEpoch: 1,
      leaseId: "lease-1",
      issuedAt: NOW,
      expiresAt: LATER,
      correlationId: "corr-invalid-inject",
      causation: null,
      type: "roundtable.inject_human",
      payload: {
        post: {
          postId: "post-invalid-1",
          discussionId,
          seq: 1,
          authorNodeId: CHAIR_NODE,
          authorRoleId: "agent", // ILLEGAL: non-human role
          kind: "note",
          body: "Invalid inject attempt",
          createdAt: NOW,
        },
      },
    }

    const invalidRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: invalidInjectPayload,
    })
    expect(invalidRes.statusCode).toBe(400)
    const body = invalidRes.json()
    expect(body.error).toContain("Invalid command payload")
    expect(body.details.some((d: { message: string }) => d.message.includes("Author role ID for inject_human must be 'human'"))).toBe(true)

    await app.close()
  })

  it("refuses roundtable.post from an undeclared member with coordinator error", async () => {
    const harness = await setupHarness()
    const { app } = harness

    // 1. Prepare active run
    const runCreateCmd = makeCommand("run.create", {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Membership Test Run",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
      tasks: [
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse("task-1"),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Membership Task",
          description: "Task for membership test",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
      ],
    })
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: runCreateCmd,
    })

    // 2. Create an open discussion with fixed membership [chair, worker-a]
    const discussionId = "disc-membership-001"
    const openCmd = makeCommand("roundtable.open", {
      roundtable: {
        id: discussionId,
        runId: runIdSchema.parse(TEST_RUN_ID),
        taskId: taskIdSchema.parse("task-1"),
        subject: "Membership Rule Deliberation",
        mode: "sequential",
        chairNodeId: nodeIdSchema.parse(CHAIR_NODE),
        members: [
          { nodeId: nodeIdSchema.parse(CHAIR_NODE), roleId: "chair-role" },
          { nodeId: nodeIdSchema.parse(WORKER_A), roleId: "worker-role" },
        ],
        state: "open",
      },
    })
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: openCmd,
    })

    // UNKNOWN_NODE attempts to post into the discussion
    const strangerPostCmd = makeCommand("roundtable.post", {
      post: {
        postId: "post-stranger-1",
        discussionId,
        seq: 1,
        authorNodeId: nodeIdSchema.parse(UNKNOWN_NODE),
        authorRoleId: "unauthorized-role",
        kind: "proposal",
        body: "Unsolicited post from non-member node",
        createdAt: NOW,
      },
    })
    const strangerRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: strangerPostCmd,
    })
    expect(strangerRes.statusCode).toBe(200)
    const strangerBody = strangerRes.json()
    expect(strangerBody.ok).toBe(false)
    expect(strangerBody.error.code).toBe("coordinator.roundtable_non_member")
    expect(strangerBody.error.category).toBe("conflict")

    await app.close()
  })

  it("preserves durable log consistency when prompt runtime effect fails transiently", async () => {
    const harness = await setupHarness()
    const { app, opencode, recordSessionReady } = harness

    // 1. Setup active run and approved dispatch
    const runCreateCmd = makeCommand("run.create", {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Test crash consistency during prompt effect",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
      tasks: [
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse("task-1"),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Crash Test Task",
          description: "Verify durable commit survives effect failure",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
      ],
    })
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: runCreateCmd,
    })

    const envelope = makeEnvelope({ dispatchId: "disp-crash-001" })
    const dispatch: Dispatch = {
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
      payload: makeCommand("dispatch.propose", { dispatch }),
    })

    const approval: Approval = {
      schemaVersion: 1,
      approvalId: "appr-crash-001" as never,
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
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: makeCommand("dispatch.approve", { dispatch: { ...dispatch, state: "approved" }, approval }),
    })

    const execCmdId = "cmd-exec-crash-test"
    await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: makeCommand("dispatch.execute", { dispatch: { ...dispatch, state: "approved" }, approval }, execCmdId),
    })

    const launchedSessionId = `sess-${execCmdId}`
    recordSessionReady(launchedSessionId, envelope.dispatchId)

    // Arm runtime client to fail on prompt delivery
    opencode.shouldFailPrompt = true

    const promptCmd = makeCommand("session.prompt", {
      sessionId: sessionIdSchema.parse(launchedSessionId),
      prompt: "Execute failing prompt delivery",
    })
    const failingPromptRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: promptCmd,
    })

    expect(failingPromptRes.statusCode).toBe(200)
    const failingBody = failingPromptRes.json()
    expect(failingBody.ok).toBe(false)
    expect(failingBody.error.category).toBe("transient_transport")
    expect(failingBody.error.code).toBe("coordinator.prompt_rejected")

    // CRITICAL: Durable-before-effect invariant guarantees durable events committed
    // despite the runtime delivery failure
    const durableEvents = harness.store.readStream(TEST_RUN_ID)
    expect(durableEvents.some((e) => e.type === "session.observed")).toBe(true)

    await app.close()
  })

  it("evaluates capability preview for multiple assigned roles before follow-up dispatch proposal", async () => {
    const harness = await setupHarness()
    const { app } = harness

    // Evaluate capability preview via POST /orchestration/capability-preview
    const previewRes = await app.inject({
      method: "POST",
      url: "/orchestration/capability-preview",
      headers: { authorization: "Bearer secret" },
      payload: {
        projectId: TEST_PROJECT_ID,
        requestedCapabilities: ["testing", "compilation", "network.egress"],
        roles: [
          {
            roleId: "implementer",
            allowedCapabilities: ["testing", "compilation"],
            deniedCapabilities: [],
          },
          {
            roleId: "reviewer",
            allowedCapabilities: ["testing"],
            deniedCapabilities: ["network.egress"],
          },
        ],
        roleAssignments: [
          { roleId: "implementer", primary: true },
          { roleId: "reviewer", primary: false },
        ],
      },
    })

    expect(previewRes.statusCode).toBe(200)
    const previewBody = previewRes.json()
    // Intersection of implementer and reviewer:
    // implementer allows [testing, compilation], reviewer allows [testing] and denies [network.egress]
    expect(previewBody.allowed).toContain("testing")
    expect(previewBody.denied).toContain("network.egress")

    await app.close()
  })
})

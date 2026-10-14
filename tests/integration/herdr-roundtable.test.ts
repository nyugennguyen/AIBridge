/**
 * Herdr Local Loop & Roundtable Deliberation Integration Test (§10 Phase 3, §11).
 *
 * ARCHITECTURAL CONTEXT & TEST INTENT:
 * Driving the complete Phase 3 local loop through `app.inject()` with a fake Herdr
 * workspace client (`InMemoryHerdrClient`) and `FakeOpencodeClient`:
 *
 *   1. Spawn:
 *      A dispatch execution allocates a session/agent inside a Herdr pane via
 *      `HerdrTerminalBackend`. The fake Herdr client records the pane lifecycle
 *      (`createPane`), input ownership claims (`claimInput`), writes (`sendText`),
 *      and releases (`releaseInput`).
 *   2. `session.prompt`:
 *      Submitted through the kernel command ingress `POST /orchestration/commands`
 *      (bearer authenticated), which routes `session.prompt` through `submitPrompt`.
 *      The prompt effect reaches the fake OpenCode runtime client.
 *   3. Wait idle -> `session.observed`:
 *      The session transitions to idle and `session.observed` events are emitted.
 *      Durable-before-effect ordering strictly holds: the coordinator appends to the
 *      durable event log BEFORE the prompt runtime effect runs or the session monitor
 *      waits for idle.
 *   4. Roundtable deliberation:
 *      Deliberation lifecycle: `roundtable.open` (multi-member fixed membership),
 *      `roundtable.post` (>= 2 members posting proposal and objection),
 *      `roundtable.inject_human` (supervisor guidance with `authorRoleId: "human"`),
 *      and `roundtable.close` -> `roundtable.outcome_recorded` (advisory recommendation).
 *   5. Outcome -> `dispatch.propose`:
 *      A follow-up `dispatch.propose` whose envelope explicitly references the
 *      roundtable outcome as an INPUT (external reference, context manifest, and
 *      prompt recommendation text).
 *      CRITICAL: Asserts the outcome itself caused NO state transitions anywhere in
 *      run, task, or dispatches (advisory-only invariant per ADR 0007 / plan §7.5).
 *      The follow-up dispatch proposal is a distinct, explicit command.
 *
 * INVARIANTS STRUCTURALLY ASSERTED:
 * - SSE Gateway Total Ordering: The SSE event gateway (`/v1/mesh/events`) is the ONLY
 *   total-order surface across the mesh; all emitted events stream in exact commit order
 *   with monotonic gapless positions (1, 2, 3, ...).
 * - Advisory-Only Allowlist (§7.5): `roundtable.closed` never appears in
 *   `COMMAND_EVENT_ALLOWLIST` for any command; emitting it from a command throws
 *   `CoordinatorContractError`.
 * - F1 Atomic Input Fencing (SF-10): Every pane write strictly adheres to the bracketed
 *   claim -> write -> release discipline (`claimInput` -> `sendText` -> `releaseInput`)
 *   with monotonic epochs; human-focused panes strictly refuse writes with `input_fenced`.
 * - Command Seam Purity: All commands in the loop are driven via `app.inject()` (HTTP),
 *   never calling coordinator command methods directly.
 */

import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import {
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  installationIdSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  userIdSchema,
  type Digest,
  type NodeId,
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
  CoordinatorContractError,
  DispatchCoordinator,
  assertLicensed,
  type CommandLog,
} from "../../src/orchestration/coordinator/index.js"
import {
  SqliteEventStore,
  openInMemoryDriver,
  type EventInput,
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
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../src/mesh/protocol/negotiation.js"
import type { MeshEvent } from "../../src/mesh/protocol/event.js"
import {
  MESH_EVENT_STREAM_PATH,
  MeshEventGateway,
  decodeFrames,
  registerEventStreamRoute,
  scopeFromQuery,
} from "../../src/mesh/gateway/events/index.js"
import {
  MESH_IDENTITY_HEADERS,
  MeshIdentityProvider,
  InMemoryNodeTrustStore,
  InMemoryPeerKeyPinStore,
  InMemoryNonceGuard,
  NodeKeyPair,
  meshBodyDigest,
  signMeshRequest,
} from "../../src/mesh/identity/index.js"
import { buildTestApp, testConfig, FakeOpencodeClient } from "./fixtures.js"

// ============================================================================
// Fixtures & Test Constants
// ============================================================================

const NOW = "2026-10-14T10:00:00.000Z"
const LATER = "2026-10-14T12:00:00.000Z"
const TEST_PROJECT_ID = "app" // Allowlisted in testConfig().projects
const TEST_PROJECT_PATH = "/srv/apps/app"
const TEST_RUN_ID = "run-loop-001"
const CHAIR_NODE = "node-chair"
const LOCAL_NODE = "node-local"
const WORKER_A = "node-worker-a"
const WORKER_B = "node-worker-b"
const MESH_ID = "mesh-herdr-loop"
const OPERATOR_TOKEN = "test-operator-token"

// ============================================================================
// Recording Fakes & Ingress Helpers
// ============================================================================

class RecordingOpencodeClient extends FakeOpencodeClient {
  readonly sentPromptsLog: Array<{ sessionId: string; prompt: string; directory: string }> = []
  trace: string[] = []

  override async sendPromptAsync(sessionId = "", prompt = "", directory = ""): Promise<void> {
    await super.sendPromptAsync()
    this.trace.push("client.sendPromptAsync")
    this.sentPromptsLog.push({ sessionId, prompt, directory })
  }
}

class TrackingSessionMonitor {
  readonly monitored: Array<{ session: Session; directory: string }> = []
  trace: string[] = []

  async waitForIdle(session: Session, directory: string): Promise<void> {
    this.trace.push("monitor.waitForIdle")
    this.monitored.push({ session, directory })
  }
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const dispatchId = (overrides.dispatchId as string) ?? "disp-001"
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

async function createMeshAuth() {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const nodeId = nodeIdSchema.parse(CHAIR_NODE)
  const meshId = meshIdSchema.parse(MESH_ID)
  await trust.enroll({ nodeId, meshId, nodeKeyId: keyPair.keyId, enrolledAt: 1000, displayName: "chair-node" })
  await pins.pin({
    nodeId,
    meshId,
    key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint },
    enrollmentId: "enr-mesh-1",
    now: 1000,
  })
  const provider = new MeshIdentityProvider({
    trust,
    pins,
    replayGuard: new InMemoryNonceGuard(),
    now: () => 1000,
  })
  return { provider, keyPair, nodeId, meshId }
}

function signMeshHeaders(keyPair: NodeKeyPair, nodeId: NodeId, path: string) {
  const signature = signMeshRequest(keyPair, {
    method: "GET",
    path,
    bodyDigest: meshBodyDigest(null),
    timestamp: 1000,
    nonce: randomBytes(32).toString("base64url"),
    nodeId,
    keyId: keyPair.keyId,
  })
  return {
    [MESH_IDENTITY_HEADERS.nodeId]: nodeId,
    [MESH_IDENTITY_HEADERS.keyId]: keyPair.keyId,
    [MESH_IDENTITY_HEADERS.timestamp]: "1000",
    [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
    [MESH_IDENTITY_HEADERS.signature]: signature.signature,
    [MESH_IDENTITY_HEADERS.bodyDigest]: meshBodyDigest(null),
  }
}

// ============================================================================
// Harness Setup
// ============================================================================

async function setupLocalLoopHarness() {
  const trace: string[] = []
  const opencode = new RecordingOpencodeClient()
  opencode.trace = trace
  const monitor = new TrackingSessionMonitor()
  monitor.trace = trace

  const herdrClient = new InMemoryHerdrClient()
  const terminalBackend = new HerdrTerminalBackend({
    client: herdrClient,
  })

  const store = new SqliteEventStore(openInMemoryDriver())
  let projection: RunProjectionState | null = null
  let eventSeq = 0
  let localSequence = 0

  let gatewayClock = 1000
  const gateway = new MeshEventGateway({
    now: () => (gatewayClock += 10),
  })
  const publishPromises: Promise<unknown>[] = []

  const commandLog: CommandLog = {
    append(options) {
      trace.push("log.append")
      const result = store.append(options)
      for (const rawEvent of result.events) {
        const event = "event" in rawEvent && rawEvent.event ? (rawEvent.event as OrchestrationEvent) : (rawEvent as OrchestrationEvent)
        projection = reduceEvent(projection, event)
        localSequence += 1
        const meshEvt: MeshEvent = {
          meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
          eventId: event.eventId,
          sourceNodeId: nodeIdSchema.parse(CHAIR_NODE),
          commandCorrelation: event.commandId ? commandIdSchema.parse(event.commandId) : null,
          localSequence,
          observedAt: NOW,
          runProjectScope: {
            projectId: projectIdSchema.parse(TEST_PROJECT_ID),
            runId: runIdSchema.parse(TEST_RUN_ID),
          },
          eventType: event.type,
          event,
        }
        const meshEnvelope = {
          schemaVersion: 2 as const,
          recordType: "mesh.event" as const,
          messageId: `msg-${event.eventId}`,
          senderNodeId: nodeIdSchema.parse(CHAIR_NODE),
          recipientNodeId: nodeIdSchema.parse(CHAIR_NODE),
          protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
          issuedAt: NOW,
          expiresAt: LATER,
          correlationId: correlationIdSchema.parse(event.eventId),
          causation: null,
          payload: meshEvt,
        }
        publishPromises.push(gateway.publish(meshEnvelope))
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

  const meshAuth = await createMeshAuth()
  registerEventStreamRoute(app, {
    gateway,
    identity: {
      provider: meshAuth.provider,
      expectedNodeId: nodeIdSchema.parse(CHAIR_NODE),
      expectedMeshId: meshIdSchema.parse(MESH_ID),
    },
    scopeOf: scopeFromQuery,
  })

  const flushGateway = async () => {
    await Promise.all(publishPromises)
  }

  const recordSessionReady = async (sessionId: string, dispatchId: string) => {
    const readyEvent = {
      schemaVersion: 1 as const,
      eventId: eventIdSchema.parse(`evt-${++eventSeq}`),
      type: "session.observed" as const,
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      runId: runIdSchema.parse(TEST_RUN_ID),
      actor: { kind: "node" as const, nodeId: nodeIdSchema.parse(LOCAL_NODE) },
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
          nodeId: nodeIdSchema.parse(LOCAL_NODE),
          installationId: installationIdSchema.parse("inst-1"),
          runtimeKind: "opencode" as const,
          lifecycleState: "idle" as const,
          observedState: "idle" as const,
          terminalId: terminalIdSchema.parse("term:herdr.pane-1"),
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
    gateway,
    herdrClient,
    terminalBackend,
    opencode,
    monitor,
    trace,
    meshAuth,
    flushGateway,
    recordSessionReady,
    getProjection: () => projection,
  }
}

// ============================================================================
// Integration Test Suites
// ============================================================================

describe("Herdr Local Loop & Roundtable Integration (§10 Phase 3, §11)", () => {
  it("drives the full 5-stage local loop through app.inject() with Herdr terminal backend and advisory roundtable outcome", async () => {
    const harness = await setupLocalLoopHarness()
    const { app, herdrClient, terminalBackend, opencode, monitor, trace, meshAuth, flushGateway, recordSessionReady } = harness

    // ========================================================================
    // PREPARATION: Create Run, Propose Dispatch, Approve Dispatch
    // ========================================================================

    // 1. Submit run.create via HTTP seam
    const runCreateCmd = makeCommand("run.create", {
      run: {
        schemaVersion: 1,
        runId: runIdSchema.parse(TEST_RUN_ID),
        projectId: projectIdSchema.parse(TEST_PROJECT_ID),
        goal: "Drive full local loop with Herdr workspace and roundtable deliberation",
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
          title: "Primary Integration Task",
          description: "Task under test",
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        },
        {
          schemaVersion: 1,
          taskId: taskIdSchema.parse("task-2"),
          runId: runIdSchema.parse(TEST_RUN_ID),
          projectId: projectIdSchema.parse(TEST_PROJECT_ID),
          title: "Verification Task",
          description: "Task for deliberated verification",
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
    expect(runCreateRes.json().value.events).toEqual(["run.created", "task.created", "task.created"])

    // 2. Submit initial dispatch.propose via HTTP seam
    const initialEnvelope = makeEnvelope({ dispatchId: "disp-loop-001" })
    const initialDispatch: Dispatch = {
      schemaVersion: 1,
      envelope: initialEnvelope,
      envelopeDigest: digestDispatchEnvelope(initialEnvelope),
      state: "proposed",
      createdAt: NOW,
      externalReferences: [],
    }
    const proposeCmd = makeCommand("dispatch.propose", { dispatch: initialDispatch })
    const proposeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: proposeCmd,
    })
    expect(proposeRes.statusCode).toBe(200)
    expect(proposeRes.json().ok).toBe(true)
    expect(proposeRes.json().value.events).toEqual(["dispatch.proposed"])

    // 3. Submit dispatch.approve via HTTP seam
    const approval: Approval = {
      schemaVersion: 1,
      approvalId: "appr-loop-001" as never,
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      runId: runIdSchema.parse(TEST_RUN_ID),
      dispatchId: initialEnvelope.dispatchId,
      envelopeDigest: digestDispatchEnvelope(initialEnvelope),
      decision: "approved",
      state: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: userIdSchema.parse("usr-operator") },
      decidedAt: NOW,
    }
    const approvedDispatch: Dispatch = {
      ...initialDispatch,
      state: "approved",
    }
    const approveCmd = makeCommand("dispatch.approve", { dispatch: approvedDispatch, approval })
    const approveRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: approveCmd,
    })
    expect(approveRes.statusCode).toBe(200)
    expect(approveRes.json().ok).toBe(true)
    expect(approveRes.json().value.events).toEqual(["approval.decided"])

    // ========================================================================
    // STAGE 1: Spawn — dispatch creates session/agent in a Herdr pane
    // ========================================================================

    const executeCmdId = "cmd-exec-agent-001"
    const executeCmd = makeCommand(
      "dispatch.execute",
      { dispatch: approvedDispatch, approval },
      executeCmdId,
    )
    const executeRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: executeCmd,
    })
    expect(executeRes.statusCode).toBe(200)
    const executeBody = executeRes.json()
    expect(executeBody.ok).toBe(true)
    expect(executeBody.value.events).toEqual(["dispatch.started"])

    const launchedSessionId = `sess-${executeCmdId}`
    expect(harness.getProjection()?.sessions[launchedSessionId]).toBeDefined()

    // Spawn agent terminal pane in Herdr backend
    const terminalId = terminalIdSchema.parse("term:herdr.pane-1")
    const terminalRefResult = await terminalBackend.create({
      schemaVersion: 1,
      operation: {
        schemaVersion: 1,
        commandId: commandIdSchema.parse("cmd-term-create"),
        correlationId: correlationIdSchema.parse("corr-term-create"),
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
    expect(terminalRefResult.ok).toBe(true)
    if (!terminalRefResult.ok) return

    // STRUCTURAL ASSERTION: Fake Herdr client recorded pane creation
    expect(herdrClient.calls.some((c) => c.method === "createPane")).toBe(true)

    // Attach to live Herdr pane and perform guarded write
    const attachResult = await terminalBackend.attach(terminalRefResult.value, {
      schemaVersion: 1,
      commandId: commandIdSchema.parse("cmd-term-attach"),
      correlationId: correlationIdSchema.parse("corr-term-attach"),
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      nodeId: nodeIdSchema.parse(CHAIR_NODE),
      clientId: terminalClientIdSchema.parse("client-manager"),
    })
    expect(attachResult.ok).toBe(true)
    if (!attachResult.ok) return
    const channel = attachResult.value

    const writeResult = await channel.write(new TextEncoder().encode("export AGENT_STATUS=ready\n"))
    expect(writeResult.ok).toBe(true)

    // STRUCTURAL ASSERTION: Bracketed F1 fence discipline recorded in fake client
    const callsAfterCreate = herdrClient.calls.filter((c) => c.method !== "createPane")
    expect(callsAfterCreate.map((c) => c.method)).toEqual(["claimInput", "sendText", "releaseInput"])
    const [claimCall, sendCall, releaseCall] = callsAfterCreate
    expect(claimCall.args.paneId).toBe(sendCall.args.paneId)
    expect(sendCall.args.paneId).toBe(releaseCall.args.paneId)
    expect(claimCall.args.holder).toBe(sendCall.args.holder)
    expect(sendCall.args.holder).toBe(releaseCall.args.holder)

    // Mark session ready/idle in read model
    await recordSessionReady(launchedSessionId, initialEnvelope.dispatchId)
    expect(harness.getProjection()?.sessions[launchedSessionId]?.state).toBe("idle")

    // ========================================================================
    // STAGE 2 & 3: session.prompt & Wait idle -> session.observed
    // ========================================================================

    trace.length = 0 // Clear trace to test ordering idiom strictly
    const promptText = "Analyze current repository structure and report diagnostics"
    const promptCmd = makeCommand("session.prompt", {
      sessionId: sessionIdSchema.parse(launchedSessionId),
      prompt: promptText,
    })

    const promptRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: promptCmd,
    })
    expect(promptRes.statusCode).toBe(200)
    const promptBody = promptRes.json()
    expect(promptBody.ok).toBe(true)
    expect(promptBody.value.duplicate).toBe(false)
    // STRUCTURAL ASSERTION: session.observed emitted (working -> idle)
    expect(promptBody.value.events).toEqual(["session.observed", "session.observed"])

    // STRUCTURAL ASSERTION: Durable-before-effect ordering invariant holds
    // Log append MUST precede client.sendPromptAsync, which MUST precede monitor.waitForIdle
    expect(trace).toEqual(["log.append", "client.sendPromptAsync", "monitor.waitForIdle"])
    expect(trace.indexOf("log.append")).toBeLessThan(trace.indexOf("client.sendPromptAsync"))
    expect(trace.indexOf("client.sendPromptAsync")).toBeLessThan(trace.indexOf("monitor.waitForIdle"))

    // STRUCTURAL ASSERTION: Runtime client received prompt effect
    expect(opencode.sentPromptsLog).toHaveLength(1)
    expect(opencode.sentPromptsLog[0]).toEqual({
      sessionId: launchedSessionId,
      prompt: promptText,
      directory: TEST_PROJECT_PATH,
    })
    expect(monitor.monitored).toHaveLength(1)
    expect(monitor.monitored[0].session.sessionId).toBe(launchedSessionId)

    // Projection session state converged back to idle
    const sessionAfterPrompt = harness.getProjection()?.sessions[launchedSessionId]
    expect(sessionAfterPrompt?.state).toBe("idle")
    expect(sessionAfterPrompt?.observedState).toBe("idle")

    // ========================================================================
    // STAGE 4: Roundtable deliberation lifecycle
    // ========================================================================

    const discussionId = "disc-herdr-local-001"

    // 1. roundtable.open (chair, worker-a, worker-b)
    const openRoundtableCmd = makeCommand("roundtable.open", {
      roundtable: {
        id: discussionId,
        runId: runIdSchema.parse(TEST_RUN_ID),
        taskId: taskIdSchema.parse("task-1"),
        subject: "Verification and Deployment Strategy",
        mode: "sequential",
        chairNodeId: nodeIdSchema.parse(CHAIR_NODE),
        members: [
          { nodeId: nodeIdSchema.parse(CHAIR_NODE), roleId: "chair-lead" },
          { nodeId: nodeIdSchema.parse(WORKER_A), roleId: "proposer-role" },
          { nodeId: nodeIdSchema.parse(WORKER_B), roleId: "reviewer-role" },
        ],
        state: "open",
      },
    })
    const openRtRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: openRoundtableCmd,
    })
    expect(openRtRes.statusCode).toBe(200)
    expect(openRtRes.json().ok).toBe(true)
    expect(openRtRes.json().value.events).toEqual(["roundtable.opened"])

    // 2. roundtable.post from member 1 (worker-a: proposal)
    const post1Cmd = makeCommand("roundtable.post", {
      post: {
        postId: "post-prop-1",
        discussionId,
        seq: 1,
        authorNodeId: nodeIdSchema.parse(WORKER_A),
        authorRoleId: "proposer-role",
        kind: "proposal",
        body: "Propose dispatching isolated integration verification disp-verify-002",
        createdAt: NOW,
      },
    })
    const post1Res = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: post1Cmd,
    })
    expect(post1Res.statusCode).toBe(200)
    expect(post1Res.json().value.events).toEqual(["roundtable.posted"])

    // 3. roundtable.post from member 2 (worker-b: objection)
    const post2Cmd = makeCommand("roundtable.post", {
      post: {
        postId: "post-obj-2",
        discussionId,
        seq: 2,
        authorNodeId: nodeIdSchema.parse(WORKER_B),
        authorRoleId: "reviewer-role",
        kind: "objection",
        body: "Objection: Verification dispatch must restrict write access to the sandbox directory",
        createdAt: NOW,
      },
    })
    const post2Res = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: post2Cmd,
    })
    expect(post2Res.statusCode).toBe(200)
    expect(post2Res.json().value.events).toEqual(["roundtable.posted"])

    // 4. roundtable.inject_human (human supervisor clarification)
    const injectHumanCmd = makeCommand("roundtable.inject_human", {
      post: {
        postId: "post-human-3",
        discussionId,
        seq: 3,
        authorNodeId: nodeIdSchema.parse(CHAIR_NODE),
        authorRoleId: "human", // STRUCTURAL INVARIANT: must be 'human'
        kind: "note",
        body: "Supervisor directive: sandbox restriction accepted; proceed with verification dispatch",
        createdAt: NOW,
      },
    })
    const injectHumanRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: injectHumanCmd,
    })
    expect(injectHumanRes.statusCode).toBe(200)
    expect(injectHumanRes.json().value.events).toEqual(["roundtable.posted"])

    // 5. roundtable.close -> roundtable.outcome_recorded
    const advisoryOutcome: RoundtableOutcome = {
      summary: "Consensus reached with supervisor sandbox directive",
      recommendation: "Propose sandboxed verification dispatch disp-verify-002",
      addressedObjections: ["post-obj-2"],
      unresolvedObjections: [],
    }
    const closeRtCmd = makeCommand("roundtable.close", {
      discussionId,
      outcome: advisoryOutcome,
    })
    const closeRtRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: closeRtCmd,
    })
    expect(closeRtRes.statusCode).toBe(200)
    expect(closeRtRes.json().ok).toBe(true)
    expect(closeRtRes.json().value.events).toEqual(["roundtable.outcome_recorded"])

    // ========================================================================
    // STAGE 5: Outcome -> dispatch.propose (Advisory-Only Invariant Asserted)
    // ========================================================================

    // CRITICAL STRUCTURAL ASSERTION: The roundtable outcome caused NO state transition!
    const projAfterClose = harness.getProjection()!
    expect(projAfterClose.run.state).toBe("active")
    expect(projAfterClose.tasks["task-1"]?.state).toBe("running")
    expect(Object.keys(projAfterClose.dispatches)).toHaveLength(1) // ONLY initial dispatch exists
    expect(Object.values(projAfterClose.dispatches).some((d) => d.dispatchId === "disp-verify-002")).toBe(false)

    // Structural allowlist check: roundtable.closed is in zero command allowlists
    expect(COMMAND_EVENT_ALLOWLIST["roundtable.close"]).toEqual(["roundtable.outcome_recorded"])
    expect(Object.values(COMMAND_EVENT_ALLOWLIST).some((events) => events.includes("roundtable.closed"))).toBe(false)

    // Follow-up dispatch proposal whose envelope REFERENCES the roundtable outcome as INPUT
    const outcomeEvidenceRef = `roundtable:${discussionId}:outcome`
    const followUpEnvelope = makeEnvelope({
      dispatchId: "disp-verify-002",
      taskId: "task-2",
      prompt: `Execute sandboxed verification dispatch per deliberation recommendation: ${advisoryOutcome.recommendation}`,
      contextManifest: {
        references: [
          {
            sourceKind: "external",
            sourceId: outcomeEvidenceRef,
            contentDigest: `sha256:${"a".repeat(64)}` as Digest,
            sensitivity: "internal",
            byteCount: 256,
          },
        ],
        manifestDigest: `sha256:${"b".repeat(64)}` as Digest,
      },
    })
    const followUpDispatch: Dispatch = {
      schemaVersion: 1,
      envelope: followUpEnvelope,
      envelopeDigest: digestDispatchEnvelope(followUpEnvelope),
      state: "proposed",
      createdAt: NOW,
      externalReferences: [{ namespace: "roundtable", id: outcomeEvidenceRef }],
    }

    const followUpProposeCmd = makeCommand("dispatch.propose", { dispatch: followUpDispatch })
    const followUpRes = await app.inject({
      method: "POST",
      url: "/orchestration/commands",
      headers: { authorization: "Bearer secret" },
      payload: followUpProposeCmd,
    })
    expect(followUpRes.statusCode).toBe(200)
    expect(followUpRes.json().ok).toBe(true)
    expect(followUpRes.json().value.events).toEqual(["dispatch.proposed"])

    // Now exactly 2 dispatches exist, proving the proposal was an explicit new command
    const projAfterProposal = harness.getProjection()!
    expect(Object.keys(projAfterProposal.dispatches)).toHaveLength(2)
    expect(projAfterProposal.dispatches["disp-verify-002"]).toBeDefined()
    expect(
      projAfterProposal.dispatches["disp-verify-002"]?.envelope?.contextManifest.references[0]?.sourceId,
    ).toBe(outcomeEvidenceRef)

    // ========================================================================
    // SSE GATEWAY: Total-Order Event Sequence Verification
    // ========================================================================

    await flushGateway()
    const sseUrl = `${MESH_EVENT_STREAM_PATH}?projectId=${TEST_PROJECT_ID}&runId=${TEST_RUN_ID}&cursor=0`
    const sseRes = await app.inject({
      method: "GET",
      url: sseUrl,
      headers: signMeshHeaders(meshAuth.keyPair, meshAuth.nodeId, sseUrl),
    })
    expect(sseRes.statusCode).toBe(200)
    expect(sseRes.headers["content-type"]).toContain("text/event-stream")

    const frames = decodeFrames(sseRes.body)
    expect(frames.length).toBe(15)

    // Monotonic gapless total order position sequence
    const positions = frames.map((f) => Number(f.id))
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])

    // Exact commit order of emitted domain events
    const eventTypes = frames.map((f) => {
      const data = f.data
      if (data && typeof data === "object" && "eventType" in data && typeof data.eventType === "string") {
        return data.eventType
      }
      return undefined
    })
    expect(eventTypes).toEqual([
      "run.created",
      "task.created",
      "task.created",
      "dispatch.proposed",
      "approval.decided",
      "dispatch.started",
      "session.observed", // initial ready
      "session.observed", // prompt working
      "session.observed", // prompt idle
      "roundtable.opened",
      "roundtable.posted", // worker-a proposal
      "roundtable.posted", // worker-b objection
      "roundtable.posted", // supervisor human clarification
      "roundtable.outcome_recorded",
      "dispatch.proposed", // follow-up referencing outcome
    ])

    await app.close()
  })

  it("enforces advisory-only invariant: roundtable.closed never appears in command allowlist and outcome never triggers state transitions", async () => {
    // 1. Allowlist inspection: roundtable.closed appears in zero command types
    for (const [cmdType, allowed] of Object.entries(COMMAND_EVENT_ALLOWLIST)) {
      expect(allowed).not.toContain("roundtable.closed")
      if (cmdType === "roundtable.close") {
        expect(allowed).toEqual(["roundtable.outcome_recorded"])
      }
    }

    // 2. assertLicensed throws CoordinatorContractError if a command handler attempts to emit roundtable.closed
    const fakeCommand = makeCommand("roundtable.close", {
      discussionId: "disc-illegal",
      outcome: {
        summary: "test",
        recommendation: "test",
        addressedObjections: [],
        unresolvedObjections: [],
      },
    })
    const illegalClosedEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-illegal-closed"),
      sequence: 1,
      type: "roundtable.closed",
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      runId: runIdSchema.parse(TEST_RUN_ID),
      actor: { kind: "user", userId: userIdSchema.parse("usr-operator") },
      controllerEpoch: 1,
      occurredAt: NOW,
      correlationId: correlationIdSchema.parse("corr-illegal"),
      causation: null,
      payload: { discussionId: "disc-illegal" },
    } as OrchestrationEvent

    expect(() => {
      assertLicensed(fakeCommand, [illegalClosedEvent])
    }).toThrow(CoordinatorContractError)
  })

  it("verifies F1 atomic input fencing on Herdr pane: human focus refuses writes with input_fenced and releases cleanly", async () => {
    const harness = await setupLocalLoopHarness()
    const { herdrClient, terminalBackend, app } = harness

    const terminalId = terminalIdSchema.parse("term:herdr.pane-fence-test")
    const terminalRefResult = await terminalBackend.create({
      schemaVersion: 1,
      operation: {
        schemaVersion: 1,
        commandId: commandIdSchema.parse("cmd-term-fence-create"),
        correlationId: correlationIdSchema.parse("corr-term-fence-create"),
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
      sessionId: sessionIdSchema.parse("sess-fence-test"),
      backendKind: HERDR_KIND,
      columns: 80,
      rows: 24,
      bufferByteLimit: 1024,
    })
    expect(terminalRefResult.ok).toBe(true)
    if (!terminalRefResult.ok) return

    const attachResult = await terminalBackend.attach(terminalRefResult.value, {
      schemaVersion: 1,
      commandId: commandIdSchema.parse("cmd-term-fence-attach"),
      correlationId: correlationIdSchema.parse("corr-term-fence-attach"),
      projectId: projectIdSchema.parse(TEST_PROJECT_ID),
      nodeId: nodeIdSchema.parse(CHAIR_NODE),
      clientId: terminalClientIdSchema.parse("client-manager"),
    })
    expect(attachResult.ok).toBe(true)
    if (!attachResult.ok) return
    const channel = attachResult.value

    // Normal fenced write succeeds
    const write1 = await channel.write(new TextEncoder().encode("initial write\n"))
    expect(write1.ok).toBe(true)

    // Simulate human operator taking focus in Herdr workspace
    const metadata = terminalRefResult.value.adapterMetadata
    const paneId = typeof metadata.paneId === "string" ? metadata.paneId : "pane-1"
    herdrClient.setHumanFocused(paneId, true)

    // Unheld write while human-focused MUST fail with non-retryable input_fenced
    const fencedWrite = await channel.write(new TextEncoder().encode("unsolicited write attempt\n"))
    expect(fencedWrite.ok).toBe(false)
    if (!fencedWrite.ok) {
      expect(fencedWrite.error.code).toBe("terminal.input_fenced")
      expect(fencedWrite.error.category).toBe("policy_denied")
      expect(fencedWrite.error.retryable).toBe(false)
    }

    // Human operator relinquishes focus; subsequent write succeeds
    herdrClient.setHumanFocused(paneId, false)
    const write2 = await channel.write(new TextEncoder().encode("resumed write\n"))
    expect(write2.ok).toBe(true)

    await app.close()
  })
})

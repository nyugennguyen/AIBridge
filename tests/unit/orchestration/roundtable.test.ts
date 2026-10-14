/**
 * Roundtable Deliberation & Controller Relay Unit & Invariant Tests.
 *
 * Exercises:
 * 1. Advisory-Only Invariant (§7.5, §11 row):
 *    - `roundtable.closed` appears in EXACTLY ZERO `COMMAND_EVENT_ALLOWLIST` entries.
 *    - Emitting `roundtable.closed` from a command handler throws `CoordinatorContractError`.
 *    - Closing a roundtable produces NO state transitions anywhere in run/task/dispatch lifecycle.
 *
 * 2. Aggregate Operations & Error Discipline (§6.3, §10):
 *    - Open: membership fixed at open, chair must be member, empty members refused.
 *    - Post: deterministic per-discussion `seq` (1, 2, 3...) assigned at append time.
 *    - Post refusals: unknown discussion, closed discussion, non-member author.
 *    - Inject human: `authorRoleId: "human"`, refusal if non-human author.
 *    - Close: advisory outcome recorded, closing twice refused.
 *
 * 3. Controller Relay (§6.3 transport, Acceptance):
 *    - Post from one member relays to every other member through the controller relay.
 *    - Sender node is never re-sent its own post.
 *    - Ingest path test with fakes.
 *    - Total order preserved: SSE gateway is sole total-order authority (`position`),
 *      per-discussion `seq` is strictly monotonic.
 *
 * 4. Durable-Before-Effect (Acceptance):
 *    - Outbox record is appended inside transaction BEFORE relay delivery occurs.
 *    - Simulated crash before delivery + redelivery is idempotent and does not double-relay.
 */

import { describe, expect, it } from "vitest"
import { MeshEventGateway } from "../../../src/mesh/gateway/events/gateway.js"
import { DefaultRoundtablePostRelay, MeshEventIngestor, type EventIngestStore } from "../../../src/mesh/outbox/ingest.js"
import { meshCommandSchema } from "../../../src/mesh/protocol/command.js"
import { meshEventSchema, type MeshEvent } from "../../../src/mesh/protocol/event.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../src/mesh/protocol/negotiation.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  CoordinatorContractError,
  assertLicensed,
  DispatchCoordinator,
  type CommandLog,
  type CoordinatorDependencies,
  type EffectTransport,
} from "../../../src/orchestration/coordinator/index.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"
import {
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { reduceEvent } from "../../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import {
  appendPost,
  closeRoundtable,
  openRoundtable,
  RoundtableRepository,
  type Post,
  type Roundtable,
  type RoundtableOutcome,
} from "../../../src/orchestration/roundtable/index.js"
import {
  orchestrationCommandSchema,
  orchestrationEventSchema,
} from "../../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../../src/orchestration/types.js"

// --- Test Fixtures & Constants ---

const PROJECT = projectIdSchema.parse("proj-roundtable-1")
const RUN = runIdSchema.parse("run-roundtable-1")
const TASK = taskIdSchema.parse("task-roundtable-1")
const NOW = "2026-10-13T10:00:00.000Z"
const LATER = "2026-10-13T11:00:00.000Z"
const ACTOR = { kind: "node" as const, nodeId: nodeIdSchema.parse("node-chair") }

function baseCommand(type: OrchestrationCommand["type"], payload: unknown, commandId = `cmd-${type}-1`): OrchestrationCommand {
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: commandIdSchema.parse(commandId),
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: nodeIdSchema.parse("node-chair"),
    controllerEpoch: 1,
    leaseId: "lease-1",
    issuedAt: NOW,
    expiresAt: LATER,
    correlationId: `corr-${commandId}`,
    causation: null,
    type,
    payload,
  }) as OrchestrationCommand
}

function makeSampleRoundtable(overrides: Partial<Roundtable> = {}): Roundtable {
  return {
    id: "disc-1",
    runId: RUN,
    taskId: TASK,
    subject: "Architectural strategy review",
    mode: "sequential",
    chairNodeId: nodeIdSchema.parse("node-chair"),
    members: [
      { nodeId: nodeIdSchema.parse("node-chair"), roleId: "chair-role" },
      { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "proposer-role" },
      { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "reviewer-role" },
    ],
    state: "open",
    ...overrides,
  }
}

function makeSampleOutcome(overrides: Partial<RoundtableOutcome> = {}): RoundtableOutcome {
  return {
    summary: "Deliberation reached consensus on single-flight outbox dispatch.",
    recommendation: "Approve dispatch proposal for worker-a.",
    addressedObjections: ["post-2"],
    unresolvedObjections: [],
    ...overrides,
  }
}

function makeHarness(options: {
  seed?: RunProjectionState
  effectTransport?: EffectTransport
  roundtables?: RoundtableRepository
} = {}) {
  const calls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const byCommandId = new Map<string, { command: OrchestrationCommand; events: readonly EventInput[] }>()
  let eventSeq = 0

  const log: CommandLog = {
    append(opts) {
      const key = opts.command.commandId
      if (byCommandId.has(key)) {
        return { duplicate: true, events: [] }
      }
      byCommandId.set(key, { command: opts.command, events: opts.events })
      calls.push({ command: opts.command, events: opts.events, outboxRecords: opts.outboxRecords ?? [] })
      return { duplicate: false, events: opts.events }
    },
  }

  let projection = options.seed ?? createInitialRunProjection()
  const roundtables = options.roundtables ?? new RoundtableRepository()

  const deps: CoordinatorDependencies = {
    log,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId) => (projection?.run.runId === runId ? projection : undefined),
    roundtables,
    ...(options.effectTransport ? { effectTransport: options.effectTransport } : {}),
  }

  const coordinator = new DispatchCoordinator(deps)

  return {
    coordinator,
    deps,
    calls,
    byCommandId,
    roundtables,
    getProjection: () => projection,
    replay: () => {
      let next = options.seed ?? createInitialRunProjection()
      let seq = next.lastAppliedSequence
      for (const call of calls) {
        for (const event of call.events) {
          next = reduceEvent(next, { ...event, sequence: ++seq } as OrchestrationEvent)
        }
      }
      projection = next
      return projection
    },
  }
}

function createInitialRunProjection(): RunProjectionState {
  const runCreated: OrchestrationEvent = {
    schemaVersion: 1,
    eventId: eventIdSchema.parse("evt-seed-run"),
    sequence: 1,
    type: "run.created",
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerEpoch: 1,
    occurredAt: NOW,
    correlationId: correlationIdSchema.parse("corr-seed"),
    causation: null,
    payload: {
      run: {
        schemaVersion: 1,
        runId: RUN,
        projectId: PROJECT,
        goal: "Test roundtable slice",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
    },
  } as OrchestrationEvent

  const taskCreated: OrchestrationEvent = {
    schemaVersion: 1,
    eventId: eventIdSchema.parse("evt-seed-task"),
    sequence: 2,
    type: "task.created",
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerEpoch: 1,
    occurredAt: NOW,
    correlationId: correlationIdSchema.parse("corr-seed"),
    causation: null,
    payload: {
      task: {
        schemaVersion: 1,
        taskId: TASK,
        projectId: PROJECT,
        runId: RUN,
        title: "Kernel deliberation task",
        description: "Advisory task",
        state: "ready",
        failurePolicy: "block",
        dependencies: [],
        externalReferences: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  } as OrchestrationEvent

  let state = reduceEvent(null, runCreated)
  state = reduceEvent(state, taskCreated)
  return state!
}

// ============================================================================
// 1. Advisory-Only Enforcement (§7.5, §11)
// ============================================================================

describe("Advisory-Only Enforcement (§7.5, §11 row)", () => {
  it("roundtable.closed appears in EXACTLY ZERO COMMAND_EVENT_ALLOWLIST entries", () => {
    // Plan §11 row: "`roundtable.closed` appears in zero COMMAND_EVENT_ALLOWLIST entries;
    // no command produces a transition from an outcome"
    const occurrences: string[] = []

    for (const [commandType, allowedEvents] of Object.entries(COMMAND_EVENT_ALLOWLIST)) {
      if (allowedEvents.includes("roundtable.closed")) {
        occurrences.push(commandType)
      }
    }

    expect(occurrences).toEqual([])
    expect(occurrences).toHaveLength(0)
  })

  it("emitting roundtable.closed from a command handler throws CoordinatorContractError via assertLicensed", () => {
    // Attempting to assert licensing on `roundtable.closed` for ANY command throws immediately
    const openCmd = baseCommand("roundtable.open", { roundtable: makeSampleRoundtable() })

    // An emitted roundtable.closed event is rejected by assertLicensed
    const unlicensedEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-bad"),
      sequence: 1,
      type: "roundtable.closed",
      projectId: PROJECT,
      runId: RUN,
      actor: ACTOR,
      controllerEpoch: 1,
      occurredAt: NOW,
      correlationId: "c",
      causation: null,
      payload: { discussionId: "disc-1" },
    } as OrchestrationEvent

    expect(() => {
      assertLicensed(openCmd, [unlicensedEvent])
    }).toThrow(CoordinatorContractError)
  })

  it("closing a roundtable produces NO state transitions anywhere in run or task lifecycles", () => {
    const harness = makeHarness()
    const roundtable = makeSampleRoundtable()

    // 1. Open discussion
    const openRes = harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }))
    expect(openRes.ok).toBe(true)

    // 2. Add posts
    const postRes1 = harness.coordinator.submit(
      baseCommand("roundtable.post", {
        post: {
          postId: "p-1",
          discussionId: roundtable.id,
          seq: 1,
          authorNodeId: "node-worker-a",
          authorRoleId: "proposer-role",
          kind: "proposal",
          body: "Propose option A",
          createdAt: NOW,
        },
      }),
    )
    expect(postRes1.ok).toBe(true)

    // 3. Close discussion with advisory outcome
    const outcome = makeSampleOutcome()
    const closeRes = harness.coordinator.submit(
      baseCommand("roundtable.close", {
        discussionId: roundtable.id,
        outcome,
      }),
    )
    expect(closeRes.ok).toBe(true)
    if (closeRes.ok) {
      expect(closeRes.value.events).toEqual(["roundtable.outcome_recorded"])
    }

    // 4. Replay projection reducer over all recorded events
    const initialProjection = harness.getProjection()
    const projectionAfterClose = harness.replay()

    // Stated invariant: Run state, lifecycleState, task states, dispatches, and approvals are COMPLETELY UNCHANGED
    expect(projectionAfterClose.run.state).toBe(initialProjection.run.state)
    expect(projectionAfterClose.run.lifecycleState).toBe(initialProjection.run.lifecycleState)
    expect(projectionAfterClose.tasks[TASK]?.lifecycleState).toBe(initialProjection.tasks[TASK]?.lifecycleState)
    expect(Object.keys(projectionAfterClose.dispatches)).toHaveLength(0)
    expect(Object.keys(projectionAfterClose.approvals)).toHaveLength(0)
    expect(Object.keys(projectionAfterClose.sessions)).toHaveLength(0)
  })
})

// ============================================================================
// 2. Aggregate Operations & Error Discipline
// ============================================================================

describe("Roundtable Aggregate Operations & Error Discipline", () => {
  it("opens a discussion with fixed membership and assigns deterministic sequence", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    let state = openRes.value
    expect(state.roundtable.id).toBe("disc-1")
    expect(state.posts).toHaveLength(0)

    // First post
    const postRes1 = appendPost(state, {
      postId: "p-1",
      discussionId: "disc-1",
      authorNodeId: nodeIdSchema.parse("node-worker-a"),
      authorRoleId: "proposer-role",
      kind: "proposal",
      body: "Initial proposal",
      createdAt: NOW,
    })
    expect(postRes1.ok).toBe(true)
    if (!postRes1.ok) return
    expect(postRes1.value.post.seq).toBe(1)
    state = postRes1.value.nextState

    // Second post
    const postRes2 = appendPost(state, {
      postId: "p-2",
      discussionId: "disc-1",
      authorNodeId: nodeIdSchema.parse("node-worker-b"),
      authorRoleId: "reviewer-role",
      kind: "objection",
      body: "Concerns about race condition",
      createdAt: NOW,
    })
    expect(postRes2.ok).toBe(true)
    if (!postRes2.ok) return
    expect(postRes2.value.post.seq).toBe(2)
    state = postRes2.value.nextState

    // Third post
    const postRes3 = appendPost(state, {
      postId: "p-3",
      discussionId: "disc-1",
      authorNodeId: nodeIdSchema.parse("node-chair"),
      authorRoleId: "chair-role",
      kind: "answer",
      body: "Resolved by lease ordering",
      createdAt: NOW,
    })
    expect(postRes3.ok).toBe(true)
    if (!postRes3.ok) return
    expect(postRes3.value.post.seq).toBe(3)
    state = postRes3.value.nextState

    expect(state.posts).toHaveLength(3)
    expect(state.posts.map((p) => p.seq)).toEqual([1, 2, 3])
  })

  it("refuses to open a roundtable if chair is not in members list", () => {
    const invalidChairRt = makeSampleRoundtable({
      chairNodeId: nodeIdSchema.parse("node-unknown-chair"),
    })
    const res = openRoundtable(invalidChairRt)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("roundtable.invalid_members")
    }
  })

  it("refuses to open a roundtable with empty members", () => {
    const emptyMembersRt = makeSampleRoundtable({
      members: [],
    })
    const res = openRoundtable(emptyMembersRt)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("roundtable.invalid_members")
    }
  })

  it("refuses duplicate opening in repository", () => {
    const repo = new RoundtableRepository()
    const rt = makeSampleRoundtable()
    const first = repo.open(rt)
    expect(first.ok).toBe(true)

    const second = repo.open(rt)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.code).toBe("roundtable.already_exists")
    }
  })

  it("refuses post by non-member", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    const res = appendPost(openRes.value, {
      postId: "p-intruder",
      discussionId: "disc-1",
      authorNodeId: nodeIdSchema.parse("node-stranger"),
      authorRoleId: "intruder-role",
      kind: "proposal",
      body: "Hello from outside",
      createdAt: NOW,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("roundtable.non_member")
    }
  })

  it("allows human injection with authorRoleId 'human' even when not in original members", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    const res = appendPost(
      openRes.value,
      {
        postId: "p-human-1",
        discussionId: "disc-1",
        authorNodeId: nodeIdSchema.parse("node-operator"),
        authorRoleId: "human",
        kind: "note",
        body: "Clarification: prioritize safety floor.",
        createdAt: NOW,
      },
      true, // isHumanInjection
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.post.authorRoleId).toBe("human")
      expect(res.value.post.seq).toBe(1)
    }
  })

  it("refuses human injection when authorRoleId is not 'human'", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    const res = appendPost(
      openRes.value,
      {
        postId: "p-human-bad",
        discussionId: "disc-1",
        authorNodeId: nodeIdSchema.parse("node-operator"),
        authorRoleId: "robot",
        kind: "note",
        body: "Impostor injection",
        createdAt: NOW,
      },
      true,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe("roundtable.invalid_author")
    }
  })

  it("refuses posting to a closed discussion", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    const closeRes = closeRoundtable(openRes.value, makeSampleOutcome())
    expect(closeRes.ok).toBe(true)
    if (!closeRes.ok) return

    const postRes = appendPost(closeRes.value.nextState, {
      postId: "p-late",
      discussionId: "disc-1",
      authorNodeId: nodeIdSchema.parse("node-worker-a"),
      authorRoleId: "proposer-role",
      kind: "note",
      body: "Too late",
      createdAt: NOW,
    })
    expect(postRes.ok).toBe(false)
    if (!postRes.ok) {
      expect(postRes.error.code).toBe("roundtable.closed")
    }
  })

  it("refuses closing a discussion twice", () => {
    const rt = makeSampleRoundtable()
    const openRes = openRoundtable(rt)
    expect(openRes.ok).toBe(true)
    if (!openRes.ok) return

    const closeRes1 = closeRoundtable(openRes.value, makeSampleOutcome())
    expect(closeRes1.ok).toBe(true)
    if (!closeRes1.ok) return

    const closeRes2 = closeRoundtable(closeRes1.value.nextState, makeSampleOutcome())
    expect(closeRes2.ok).toBe(false)
    if (!closeRes2.ok) {
      expect(closeRes2.error.code).toBe("roundtable.closed")
    }
  })
})

// ============================================================================
// 3. Controller Relay (§6.3 Transport)
// ============================================================================

describe("Controller Relay (§6.3 Transport & Mesh Ingest)", () => {
  it("relays a member post to all other members, excluding the sender node", async () => {
    const repository = new RoundtableRepository()
    const roundtable = makeSampleRoundtable({
      members: [
        { nodeId: nodeIdSchema.parse("node-chair"), roleId: "chair-role" },
        { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "proposer-role" },
        { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "reviewer-role" },
      ],
    })
    repository.open(roundtable)

    const delivered: { destination: string; event: MeshEvent }[] = []
    const fakeTransport = {
      async deliver(record: { destination: string; event: MeshEvent }) {
        delivered.push(record)
      },
    }

    const relay = new DefaultRoundtablePostRelay({
      roundtables: repository,
      transport: fakeTransport,
    })

    // Suppose worker-a posts to the controller
    const postResult = repository.post({
      postId: "post-worker-a-1",
      discussionId: roundtable.id,
      authorNodeId: nodeIdSchema.parse("node-worker-a"),
      authorRoleId: "proposer-role",
      kind: "proposal",
      body: "RFC proposal from worker A",
      createdAt: NOW,
    })
    expect(postResult.ok).toBe(true)
    if (!postResult.ok) return

    const postEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-post-1"),
      sequence: 1,
      type: "roundtable.posted",
      projectId: PROJECT,
      runId: RUN,
      actor: { kind: "node", nodeId: "node-worker-a" },
      controllerEpoch: 1,
      occurredAt: NOW,
      correlationId: "corr-1",
      causation: null,
      payload: { post: postResult.value.post },
    } as OrchestrationEvent

    const incomingMeshEvent: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("mevt-incoming-1"),
      sourceNodeId: nodeIdSchema.parse("node-worker-a"),
      commandCorrelation: null,
      localSequence: 1,
      observedAt: NOW,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.posted",
      event: postEvent,
    }

    const relayOutcome = await relay.relay(incomingMeshEvent)
    expect(relayOutcome.ok).toBe(true)
    if (relayOutcome.ok) {
      // Recipient nodes are node-chair and node-worker-b
      expect([...relayOutcome.value].sort()).toEqual(["node-chair", "node-worker-b"].sort())
    }

    // Assert delivered records
    expect(delivered).toHaveLength(2)
    const destinations = delivered.map((d) => d.destination).sort()
    expect(destinations).toEqual(["node-chair", "node-worker-b"].sort())

    // CRITICAL: Sender node 'node-worker-a' is NOT re-sent its own post
    expect(destinations).not.toContain("node-worker-a")
  })

  it("relays through MeshEventIngestor path with fakes, preserving total order on SSE gateway", async () => {
    const repository = new RoundtableRepository()
    const roundtable = makeSampleRoundtable({
      chairNodeId: nodeIdSchema.parse("node-worker-a"),
      members: [
        { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "role-a" },
        { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "role-b" },
      ],
    })
    const openRes = repository.open(roundtable)
    expect(openRes.ok).toBe(true)

    // Ingest stores on nodes
    const controllerStoreSeen = new Set<string>()
    const controllerStore: EventIngestStore = {
      async seen(eventId) {
        return { ok: true, value: controllerStoreSeen.has(eventId) }
      },
      async apply(event) {
        controllerStoreSeen.add(event.eventId)
        return { ok: true, value: undefined }
      },
    }

    const workerBStoreSeen = new Set<string>()
    const workerBStore: EventIngestStore = {
      async seen(eventId) {
        return { ok: true, value: workerBStoreSeen.has(eventId) }
      },
      async apply(event) {
        workerBStoreSeen.add(event.eventId)
        return { ok: true, value: undefined }
      },
    }

    const workerBIngestor = new MeshEventIngestor({ store: workerBStore })

    // Transport on controller delivers to worker B's ingestor
    const transport = {
      async deliver(record: { destination: string; event: MeshEvent }) {
        if (record.destination === "node-worker-b") {
          const outcome = await workerBIngestor.ingest(record.event)
          expect(outcome.ok).toBe(true)
        }
      },
    }

    const controllerRelay = new DefaultRoundtablePostRelay({
      roundtables: repository,
      transport,
    })

    const controllerIngestor = new MeshEventIngestor({
      store: controllerStore,
      relay: controllerRelay,
    })

    // SSE Event Gateway on controller
    let clock = 1000
    const gateway = new MeshEventGateway({
      now: () => (clock += 10),
    })

    // Worker A produces post 1
    const p1 = repository.post({
      postId: "p-a-1",
      discussionId: roundtable.id,
      authorNodeId: nodeIdSchema.parse("node-worker-a"),
      authorRoleId: "role-a",
      kind: "proposal",
      body: "First post",
      createdAt: NOW,
    })
    expect(p1.ok).toBe(true)
    if (!p1.ok) return
    expect(p1.value.post.seq).toBe(1)

    const event1: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("mevt-a-1"),
      sourceNodeId: nodeIdSchema.parse("node-worker-a"),
      commandCorrelation: null,
      localSequence: 1,
      observedAt: NOW,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.posted",
      event: {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("mevt-a-1"),
        sequence: 1,
        type: "roundtable.posted",
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "node", nodeId: "node-worker-a" },
        controllerEpoch: 1,
        occurredAt: NOW,
        correlationId: "corr-1",
        causation: null,
        payload: { post: p1.value.post },
      } as OrchestrationEvent,
    }

    // Ingest at controller -> triggers relay to worker B
    const outcome1 = await controllerIngestor.ingest(event1)
    expect(outcome1.ok).toBe(true)
    if (outcome1.ok) expect(outcome1.value.status).toBe("applied")

    function makeMeshEnvelope(evt: MeshEvent) {
      return {
        schemaVersion: 2,
        recordType: "mesh.event",
        messageId: `msg-${evt.eventId}`,
        senderNodeId: evt.sourceNodeId,
        recipientNodeId: "node-chair",
        protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
        issuedAt: evt.observedAt,
        expiresAt: new Date(Date.parse(evt.observedAt) + 3_600_000).toISOString(),
        correlationId: evt.eventId,
        causation: null,
        payload: evt,
      }
    }

    // Publish to SSE gateway: gets total-order position 1
    const pub1 = await gateway.publish(makeMeshEnvelope(event1))
    expect(pub1.ok).toBe(true)
    let pos1 = 0
    if (pub1.ok && pub1.outcome.accepted) {
      pos1 = pub1.outcome.entry.position
      expect(pos1).toBe(1)
    }
    // Verify worker B received post 1
    expect(workerBStoreSeen.size).toBe(1)

    // Worker A produces post 2
    const p2 = repository.post({
      postId: "p-a-2",
      discussionId: roundtable.id,
      authorNodeId: nodeIdSchema.parse("node-worker-a"),
      authorRoleId: "role-a",
      kind: "note",
      body: "Second post",
      createdAt: NOW,
    })
    expect(p2.ok).toBe(true)
    if (!p2.ok) return
    expect(p2.value.post.seq).toBe(2)

    const event2: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("mevt-a-2"),
      sourceNodeId: nodeIdSchema.parse("node-worker-a"),
      commandCorrelation: null,
      localSequence: 2,
      observedAt: NOW,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.posted",
      event: {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("mevt-a-2"),
        sequence: 2,
        type: "roundtable.posted",
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "node", nodeId: "node-worker-a" },
        controllerEpoch: 1,
        occurredAt: NOW,
        correlationId: "corr-2",
        causation: null,
        payload: { post: p2.value.post },
      } as OrchestrationEvent,
    }

    const outcome2 = await controllerIngestor.ingest(event2)
    expect(outcome2.ok).toBe(true)
    if (outcome2.ok) expect(outcome2.value.status).toBe("applied")

    // Publish to SSE gateway: gets total-order position 2
    const pub2 = await gateway.publish(makeMeshEnvelope(event2))
    expect(pub2.ok).toBe(true)
    let pos2 = 0
    if (pub2.ok && pub2.outcome.accepted) {
      pos2 = pub2.outcome.entry.position
      expect(pos2).toBe(2)
    }

    // Total order preserved:
    // 1. Post seq monotonicity verified (1 then 2)
    expect(p1.value.post.seq).toBe(1)
    expect(p2.value.post.seq).toBe(2)
    // 2. Gateway position monotonicity verified (1 then 2)
    expect(pos1).toBeLessThan(pos2)
    expect(pos1).toBe(1)
    expect(pos2).toBe(2)
  })
})

// ============================================================================
// 4. Durable-Before-Effect & Crash-Safety Trace Test
// ============================================================================

describe("Durable-Before-Effect & Outbox Redelivery Trace Tests", () => {
  it("strictly appends the outbox row before any relay delivery runs (trace test)", async () => {
    const trace: string[] = []

    const trackingTransport: EffectTransport = {
      async deliver(record) {
        trace.push(`deliver:${record.destination}`)
      },
    }

    const calls: OutboxRecordInput[] = []
    const byCommandId = new Map<string, OrchestrationCommand>()

    const trackingLog: CommandLog = {
      append(options) {
        trace.push("log.append")
        for (const outbox of options.outboxRecords ?? []) {
          calls.push(outbox)
        }
        byCommandId.set(options.command.commandId, options.command)
        return { duplicate: false, events: options.events }
      },
    }

    const roundtable = makeSampleRoundtable()
    const repository = new RoundtableRepository()
    repository.open(roundtable)

    const projection = createInitialRunProjection()
    const deps: CoordinatorDependencies = {
      log: trackingLog,
      now: () => NOW,
      newEventId: () => "evt-trace-1",
      readRun: (runId) => (projection.run.runId === runId ? projection : undefined),
      roundtables: repository,
      effectTransport: trackingTransport,
    }

    const coordinator = new DispatchCoordinator(deps)

    const postCmd = baseCommand("roundtable.post", {
      post: {
        postId: "post-trace-1",
        discussionId: roundtable.id,
        seq: 1,
        authorNodeId: "node-worker-a",
        authorRoleId: "proposer-role",
        kind: "proposal",
        body: "Trace ordering test",
        createdAt: NOW,
      },
    }) as Extract<OrchestrationCommand, { type: "roundtable.post" }>

    const result = await coordinator.submitPost(postCmd)
    expect(result.ok).toBe(true)

    // Stated invariant: the row was durable BEFORE any delivery effect ran
    expect(trace[0]).toBe("log.append")
    expect(trace.length).toBeGreaterThan(1)
    expect(trace.indexOf("log.append")).toBeLessThan(trace.indexOf("deliver:node-chair"))
    expect(trace.indexOf("log.append")).toBeLessThan(trace.indexOf("deliver:node-worker-b"))

    // Outbox records were created for all other members (chair and worker-b)
    expect(calls).toHaveLength(2)
    const outboxDestinations = calls.map((c) => c.destination).sort()
    expect(outboxDestinations).toEqual(["node-chair", "node-worker-b"].sort())
  })

  it("simulated crash before delivery + redelivery is idempotent and does not double-relay", async () => {
    const deliveredCount: Record<string, number> = {}

    const trackingTransport: EffectTransport = {
      async deliver(record) {
        deliveredCount[record.outboxId] = (deliveredCount[record.outboxId] ?? 0) + 1
      },
    }

    const byCommandId = new Map<string, OrchestrationCommand>()
    let crashOnFirstAttempt = true

    const trackingLog: CommandLog = {
      append(options) {
        const key = options.command.commandId
        if (byCommandId.has(key)) {
          return { duplicate: true, events: [] }
        }
        byCommandId.set(key, options.command)
        return { duplicate: false, events: options.events }
      },
    }

    const roundtable = makeSampleRoundtable()
    const repository = new RoundtableRepository()
    repository.open(roundtable)

    const projection = createInitialRunProjection()
    const deps: CoordinatorDependencies = {
      log: trackingLog,
      now: () => NOW,
      newEventId: () => "evt-crash-1",
      readRun: (runId) => (projection.run.runId === runId ? projection : undefined),
      roundtables: repository,
      effectTransport: {
        async deliver(record) {
          if (crashOnFirstAttempt) {
            // Simulate crash before delivery takes place!
            crashOnFirstAttempt = false
            throw new Error("Simulated network crash during post delivery")
          }
          await trackingTransport.deliver(record)
        },
      },
    }

    const coordinator = new DispatchCoordinator(deps)

    const postCmd = baseCommand("roundtable.post", {
      post: {
        postId: "post-crash-1",
        discussionId: roundtable.id,
        seq: 1,
        authorNodeId: "node-worker-a",
        authorRoleId: "proposer-role",
        kind: "proposal",
        body: "Crash consistency test",
        createdAt: NOW,
      },
    }) as Extract<OrchestrationCommand, { type: "roundtable.post" }>

    // Attempt 1: Durable append succeeds, but delivery crashes
    const firstAttempt = await coordinator.submitPost(postCmd)
    expect(firstAttempt.ok).toBe(false)
    if (!firstAttempt.ok) {
      expect(firstAttempt.error.code).toBe("coordinator.relay_delivery_failed")
    }

    // Attempt 2: Redelivery of the SAME command id
    const secondAttempt = await coordinator.submitPost(postCmd)
    expect(secondAttempt.ok).toBe(true)
    if (secondAttempt.ok) {
      // Redelivery is recognized as duplicate in the durable log; duplicate: true
      expect(secondAttempt.value.duplicate).toBe(true)
    }

    // No double delivery happened: outbox ids were recognized as identical
    for (const count of Object.values(deliveredCount)) {
      expect(count).toBeLessThanOrEqual(1)
    }
  })
})

// ============================================================================
// 5. Wire Protocol Payload Variants (No new wire family)
// ============================================================================

describe("Mesh Protocol Payload Variants (§6.3 Transport)", () => {
  it("transports roundtable.post as a payload variant of meshCommandSchema without new wire family", () => {
    const postCmd = baseCommand("roundtable.post", {
      post: {
        postId: "p-wire-1",
        discussionId: "disc-1",
        seq: 1,
        authorNodeId: "node-worker-a",
        authorRoleId: "proposer-role",
        kind: "proposal",
        body: "Wire payload test",
        createdAt: NOW,
      },
    })

    const meshCmd = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      commandId: postCmd.commandId,
      projectId: postCmd.projectId,
      runId: postCmd.runId,
      dispatchId: null, // Roundtable commands are not scoped to a single dispatch
      targetNodeId: "node-worker-a",
      controllerNodeId: postCmd.controllerNodeId,
      controllerEpoch: postCmd.controllerEpoch,
      leaseId: postCmd.leaseId,
      issuedAt: postCmd.issuedAt,
      expiresAt: postCmd.expiresAt,
      commandType: "roundtable.post",
      payloadDigest: digestJson(postCmd),
      command: postCmd,
    }

    const parsed = meshCommandSchema.safeParse(meshCmd)
    expect(parsed.success).toBe(true)
  })

  it("transports roundtable.posted as a payload variant of meshEventSchema without new wire family", () => {
    const postEvt: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-wire-post"),
      sequence: 1,
      type: "roundtable.posted",
      projectId: PROJECT,
      runId: RUN,
      actor: ACTOR,
      controllerEpoch: 1,
      occurredAt: NOW,
      correlationId: "corr-1",
      causation: null,
      payload: {
        post: {
          postId: "p-wire-1",
          discussionId: "disc-1",
          seq: 1,
          authorNodeId: "node-worker-a",
          authorRoleId: "proposer-role",
          kind: "proposal",
          body: "Wire event payload test",
          createdAt: NOW,
        },
      },
    } as OrchestrationEvent

    const meshEvt = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: postEvt.eventId,
      sourceNodeId: "node-chair",
      commandCorrelation: null,
      localSequence: 1,
      observedAt: NOW,
      runProjectScope: {
        projectId: PROJECT,
        runId: RUN,
      },
      eventType: "roundtable.posted",
      event: postEvt,
    }

    const parsed = meshEventSchema.safeParse(meshEvt)
    expect(parsed.success).toBe(true)
  })
})

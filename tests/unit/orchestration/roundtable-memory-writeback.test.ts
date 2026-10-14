/**
 * Memory Write-Back from Roundtable Outcomes Tests (Plan §6.3, §7.5, §10 Phase 5 row 3).
 *
 * Verifies that:
 * 1. Closing a roundtable with an outcome produces exactly one memory record.
 * 2. Provenance: `sourceReferences` contain the discussion's post ids.
 * 3. Trust state: `trustState` matches the plan (`proposed`, never `accepted`).
 * 4. Durable commit & outbox discipline: outbox record rides the same commit as outcome event.
 * 5. Failure isolation: a failed memory write does NOT corrupt or roll back the outcome commit.
 */

import { describe, expect, it } from "vitest"
import { InMemoryMemoryRepository } from "../../../src/memory/in-memory-repository.js"
import type { MemoryRepository } from "../../../src/memory/ports.js"
import { isMemoryRecordV2 } from "../../../src/memory/record.js"
import {
  DispatchCoordinator,
  MEMORY_WRITEBACK_DESTINATION,
  type CommandLog,
  type CoordinatorDependencies,
} from "../../../src/orchestration/coordinator/index.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"
import {
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
  userIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import { RoundtableRepository } from "../../../src/orchestration/roundtable/index.js"
import type {
  Roundtable,
  RoundtableOutcome,
} from "../../../src/orchestration/roundtable/types.js"
import {
  memoryRecordSchema,
  orchestrationCommandSchema,
} from "../../../src/orchestration/schemas.js"
import type {
  OrchestrationCommand,
  OrchestrationEvent,
} from "../../../src/orchestration/types.js"

const PROJECT = projectIdSchema.parse("proj-writeback-1")
const RUN = runIdSchema.parse("run-writeback-1")
const TASK = taskIdSchema.parse("task-writeback-1")
const NOW = "2026-10-14T10:00:00.000Z"
const LATER = "2026-10-14T11:00:00.000Z"
const CHAIR_NODE = nodeIdSchema.parse("node-chair")
const WORKER_NODE = nodeIdSchema.parse("node-worker-a")
const ACTOR = { kind: "user" as const, userId: userIdSchema.parse("usr-operator") }

function baseCommand(type: OrchestrationCommand["type"], payload: unknown, commandId = `cmd-${type}-1`): OrchestrationCommand {
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: commandIdSchema.parse(commandId),
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: CHAIR_NODE,
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
    id: "disc-rt-101",
    runId: RUN,
    taskId: TASK,
    subject: "Storage engine architecture deliberation",
    mode: "sequential",
    chairNodeId: CHAIR_NODE,
    members: [
      { nodeId: CHAIR_NODE, roleId: "chair" },
      { nodeId: WORKER_NODE, roleId: "implementer" },
    ],
    state: "open",
    ...overrides,
  }
}

function makeSampleOutcome(overrides: Partial<RoundtableOutcome> = {}): RoundtableOutcome {
  return {
    summary: "Consensus reached on SQLite WAL outbox discipline",
    recommendation: "Proceed with durable atomic append and post-commit write-back",
    addressedObjections: ["post-102"],
    unresolvedObjections: [],
    ...overrides,
  }
}

function makeRunProjection(): RunProjectionState {
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
        title: "Architecture task",
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

class FailingMemoryRepository extends InMemoryMemoryRepository {
  override append(): Promise<never> {
    throw new Error("Memory disk buffer I/O failure")
  }
}

class RejectingMemoryRepository extends InMemoryMemoryRepository {
  override append(): Promise<never> {
    return Promise.reject(new Error("Async network store timeout"))
  }
}

interface TestHarness {
  readonly coordinator: DispatchCoordinator
  readonly memoryRepository: InMemoryMemoryRepository
  readonly roundtables: RoundtableRepository
  readonly logCalls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[]
}

function createTestHarness(options: {
  memoryRepository?: MemoryRepository
  logAppendError?: Error
} = {}): TestHarness {
  const logCalls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const byCommandId = new Map<string, { command: OrchestrationCommand; events: readonly EventInput[] }>()
  let eventSeq = 0

  const log: CommandLog = {
    append(opts) {
      if (options.logAppendError) {
        throw options.logAppendError
      }
      const key = opts.command.commandId
      if (byCommandId.has(key)) {
        return { duplicate: true, events: [] }
      }
      byCommandId.set(key, { command: opts.command, events: opts.events })
      logCalls.push({ command: opts.command, events: opts.events, outboxRecords: opts.outboxRecords ?? [] })
      return { duplicate: false, events: opts.events }
    },
  }

  const memoryRepository = (options.memoryRepository as InMemoryMemoryRepository | undefined) ?? new InMemoryMemoryRepository({ now: () => NOW })
  const roundtables = new RoundtableRepository()
  const projection = makeRunProjection()

  const deps: CoordinatorDependencies = {
    log,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId) => (runId === RUN ? projection : undefined),
    roundtables,
    memoryRepository,
  }

  const coordinator = new DispatchCoordinator(deps)

  return {
    coordinator,
    memoryRepository,
    roundtables,
    logCalls,
  }
}

describe("P5 row 3: Memory Write-Back from Outcomes", () => {
  it("closing a roundtable with an outcome produces exactly one memory record with post id provenance and proposed trust state", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable()

    // 1. Open discussion
    const openRes = harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-1"))
    expect(openRes.ok).toBe(true)

    // 2. Add posts
    const post1 = {
      postId: "post-101",
      discussionId: roundtable.id,
      seq: 1,
      authorNodeId: CHAIR_NODE,
      authorRoleId: "chair",
      kind: "proposal" as const,
      body: "Proposal: use outbox for all memory writes",
      createdAt: NOW,
    }
    const postRes1 = harness.coordinator.submit(baseCommand("roundtable.post", { post: post1 }, "cmd-post-1"))
    expect(postRes1.ok).toBe(true)

    const post2 = {
      postId: "post-102",
      discussionId: roundtable.id,
      seq: 2,
      authorNodeId: WORKER_NODE,
      authorRoleId: "implementer",
      kind: "objection" as const,
      body: "Objection: memory write failure must not abort outcome commit",
      createdAt: NOW,
    }
    const postRes2 = harness.coordinator.submit(baseCommand("roundtable.post", { post: post2 }, "cmd-post-2"))
    expect(postRes2.ok).toBe(true)

    // 3. Close roundtable with advisory outcome
    const outcome = makeSampleOutcome()
    const closeRes = await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-1") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )
    expect(closeRes.ok).toBe(true)
    if (closeRes.ok) {
      expect(closeRes.value.events).toEqual(["roundtable.outcome_recorded"])
    }

    // 4. Acceptance Check: Exactly ONE memory record produced in memory repository
    const storedRecords = await harness.memoryRepository.listProjectUnscoped(PROJECT)
    expect(storedRecords).toHaveLength(1)

    const record = storedRecords[0]
    expect(record).toBeDefined()
    if (!isMemoryRecordV2(record)) throw new Error("Expected MemoryRecordV2")

    // 5. Acceptance Check: trustState matches the plan (§7, §10 row 3) -> "proposed"
    expect(record.trust).toBe("proposed")

    // 6. Acceptance Check: sourceReferences contain the discussion's post ids and discussionId
    expect(record.sourceReferences).toBeDefined()
    const sourceRefs = record.sourceReferences!
    expect(sourceRefs).toContainEqual({ namespace: "discussionId", id: roundtable.id })
    expect(sourceRefs).toContainEqual({ namespace: "postId", id: "post-101" })
    expect(sourceRefs).toContainEqual({ namespace: "postId", id: "post-102" })

    // 7. Verify M0 record surface validation
    const m0Record = memoryRecordSchema.safeParse({
      schemaVersion: 1,
      memoryId: record.memoryId,
      projectId: record.projectId,
      kind: record.kind,
      content: record.payload.content,
      contentDigest: record.contentHash,
      scope: record.scope,
      author: record.author,
      createdAt: record.createdAt,
      sourceReferences: record.sourceReferences,
      trustState: record.trust,
      sensitivity: "internal",
      retention: record.retention,
    })
    expect(m0Record.success).toBe(true)

    // 8. Scope honors task scope when opened on a task
    expect(record.scope).toEqual({ kind: "task", runId: RUN, taskId: TASK })
  })

  it("the write-back rides the same durable commit as the outcome via outbox", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-2"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-201",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Atomic transaction verification",
            createdAt: NOW,
          },
        },
        "cmd-post-201",
      ),
    )

    const outcome = makeSampleOutcome()
    const closeRes = harness.coordinator.submit(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-2"),
    )
    expect(closeRes.ok).toBe(true)

    // Verify durable log append call contains BOTH the event and the outbox record
    const closeCall = harness.logCalls.find((call) => call.command.type === "roundtable.close")
    expect(closeCall).toBeDefined()
    expect(closeCall!.events).toHaveLength(1)
    expect(closeCall!.events[0].type).toBe("roundtable.outcome_recorded")

    // Outbox record rides the SAME append transaction
    expect(closeCall!.outboxRecords).toHaveLength(1)
    const outbox = closeCall!.outboxRecords[0]
    expect(outbox.destination).toBe(MEMORY_WRITEBACK_DESTINATION)
    expect(outbox.outboxId).toBe("obx-cmd-close-2-memory")

    const outboxPayload = outbox.payload as { discussionId: string; memory: { sourceReferences: readonly { namespace: string; id: string }[] } }
    expect(outboxPayload.discussionId).toBe(roundtable.id)
    expect(outboxPayload.memory.sourceReferences).toContainEqual({ namespace: "postId", id: "post-201" })
  })

  it("failed memory write does not corrupt the outcome commit (synchronous failure isolation)", async () => {
    const failingMemoryRepo = new FailingMemoryRepository({ now: () => NOW })
    const harness = createTestHarness({ memoryRepository: failingMemoryRepo })
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-fail-sync"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-301",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Failure test post",
            createdAt: NOW,
          },
        },
        "cmd-post-301",
      ),
    )

    // Submit close: even though memory write throws, outcome commit succeeds!
    const outcome = makeSampleOutcome()
    const closeRes = harness.coordinator.submit(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-fail-sync"),
    )

    // Outcome commit is NOT corrupted, returns ok: true
    expect(closeRes.ok).toBe(true)
    if (closeRes.ok) {
      expect(closeRes.value.events).toEqual(["roundtable.outcome_recorded"])
    }

    // Outcome was durably committed to the log
    const closeCall = harness.logCalls.find((call) => call.command.type === "roundtable.close")
    expect(closeCall).toBeDefined()
    expect(closeCall!.events[0].type).toBe("roundtable.outcome_recorded")
    expect(closeCall!.outboxRecords[0].destination).toBe(MEMORY_WRITEBACK_DESTINATION)

    // Aggregate discussion state is closed
    const discussionState = harness.roundtables.get(roundtable.id)
    expect(discussionState?.roundtable.state).toBe("closed")
  })

  it("failed memory write does not corrupt the outcome commit (asynchronous promise rejection isolation)", async () => {
    const rejectingMemoryRepo = new RejectingMemoryRepository({ now: () => NOW })
    const harness = createTestHarness({ memoryRepository: rejectingMemoryRepo })
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-fail-async"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-401",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Async rejection test post",
            createdAt: NOW,
          },
        },
        "cmd-post-401",
      ),
    )

    const outcome = makeSampleOutcome()
    const closeRes = await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-fail-async") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )

    // Outcome commit is NOT corrupted
    expect(closeRes.ok).toBe(true)
    if (closeRes.ok) {
      expect(closeRes.value.events).toEqual(["roundtable.outcome_recorded"])
    }

    // Outcome was durably recorded
    const closeCall = harness.logCalls.find((call) => call.command.type === "roundtable.close")
    expect(closeCall).toBeDefined()
    expect(closeCall!.events[0].type).toBe("roundtable.outcome_recorded")
  })

  it("run-scoped roundtable (no taskId) writes back a run-scoped memory record", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable({ id: "disc-run-only", taskId: undefined })

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-run-only"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-501",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "note",
            body: "Run-level discussion",
            createdAt: NOW,
          },
        },
        "cmd-post-501",
      ),
    )

    const outcome = makeSampleOutcome()
    const closeRes = await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-run-only") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )
    expect(closeRes.ok).toBe(true)

    const stored = await harness.memoryRepository.listProjectUnscoped(PROJECT)
    expect(stored).toHaveLength(1)
    const rec = stored[0]
    if (!isMemoryRecordV2(rec)) throw new Error("Expected MemoryRecordV2")
    expect(rec.scope).toEqual({ kind: "run", runId: RUN })
    expect(rec.sourceReferences).toContainEqual({ namespace: "postId", id: "post-501" })
  })

  it("retrying roundtable.close with same command id is idempotent and does not produce duplicate memory records", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-idem"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-601",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Idempotency post",
            createdAt: NOW,
          },
        },
        "cmd-post-601",
      ),
    )

    const outcome = makeSampleOutcome()
    const closeCmd = baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-idem") as Extract<OrchestrationCommand, { type: "roundtable.close" }>

    // First submission
    const firstRes = await harness.coordinator.submitClose(closeCmd)
    expect(firstRes.ok).toBe(true)
    if (firstRes.ok) {
      expect(firstRes.value.duplicate).toBe(false)
    }

    // Retry closing the already-closed discussion is refused by the domain precondition
    const retryRes = await harness.coordinator.submitClose(closeCmd)
    expect(retryRes.ok).toBe(false)
    if (!retryRes.ok) {
      expect(retryRes.error.code).toMatch(/roundtable(_already)?_closed/)
    }

    // Invariant: Exactly one memory record was appended; no duplicate write-back occurred
    const stored = await harness.memoryRepository.listProjectUnscoped(PROJECT)
    expect(stored).toHaveLength(1)
  })
})

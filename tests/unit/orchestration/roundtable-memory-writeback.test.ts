/**
 * Memory Write-Back from Roundtable Outcomes Tests (Plan §6.3, §7.5, §10 Phase 5 row 3).
 *
 * Verifies that:
 * 1. Closing a roundtable with an outcome produces exactly one memory record.
 * 2. Provenance: `sourceReferences` contain the discussion's post ids.
 * 3. Trust state: `trustState` matches the plan (`proposed`, never `accepted`).
 * 4. Durable commit & outbox discipline: outbox record rides the same commit as outcome event.
 * 5. Failure isolation: a failed memory write does NOT corrupt or roll back the outcome commit.
 * 6. Durability review: failed append leaves row PENDING (not delivered) with error visible.
 * 7. Exactly-once redelivery: sweep retries pending write-backs keyed by outboxId; success marks delivered; no double-write.
 */

import { describe, expect, it } from "vitest"
import { durable, reopen } from "../mesh/outbox/helpers.js"
import { SqliteEventStore } from "../../../src/orchestration/event-store/index.js"
import { InMemoryMemoryRepository } from "../../../src/memory/in-memory-repository.js"
import type { AppendMemoryInput, AppendMemoryResult, MemoryRepository } from "../../../src/memory/ports.js"
import { isMemoryRecordV2 } from "../../../src/memory/record.js"
import {
  DispatchCoordinator,
  MEMORY_WRITEBACK_DESTINATION,
  type CommandLog,
  type CoordinatorDependencies,
} from "../../../src/orchestration/coordinator/index.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"
import type { Result } from "../../../src/orchestration/errors.js"
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

class SyncFailingMemoryRepository extends InMemoryMemoryRepository {
  override append(): Promise<never> {
    throw new Error("Memory disk buffer I/O failure")
  }
}

class FlakyMemoryRepository extends InMemoryMemoryRepository {
  shouldFail = true
  failMode: "throw" | "reject" = "throw"

  override append(input: AppendMemoryInput): Promise<Result<AppendMemoryResult>> {
    if (this.shouldFail) {
      if (this.failMode === "throw") {
        throw new Error("Memory disk buffer I/O failure")
      }
      return Promise.reject(new Error("Async network store timeout"))
    }
    return super.append(input)
  }
}

interface TestHarness {
  readonly coordinator: DispatchCoordinator
  readonly memoryRepository: InMemoryMemoryRepository
  readonly roundtables: RoundtableRepository
  readonly logCalls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[]
  readonly acknowledgedOutboxIds: string[]
  readonly failedOutboxIds: string[]
}

function createTestHarness(options: {
  memoryRepository?: MemoryRepository
  logAppendError?: Error
} = {}): TestHarness {
  const logCalls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const byCommandId = new Map<string, { command: OrchestrationCommand; events: readonly EventInput[] }>()
  const acknowledgedOutboxIds: string[] = []
  const failedOutboxIds: string[] = []
  let eventSeq = 0

  const log: CommandLog & {
    markOutboxAcknowledged(id: string, now: string): void
    markOutboxFailed(id: string, error: unknown): void
  } = {
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
    markOutboxAcknowledged(id: string) {
      acknowledgedOutboxIds.push(id)
    },
    markOutboxFailed(id: string) {
      failedOutboxIds.push(id)
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
    acknowledgedOutboxIds,
    failedOutboxIds,
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

  it("failed memory write leaves outbox row PENDING with error visible and does not corrupt outcome commit (synchronous throw)", () => {
    const syncFailingRepo = new SyncFailingMemoryRepository({ now: () => NOW })
    const harness = createTestHarness({ memoryRepository: syncFailingRepo })
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

    // Durability review invariant: row is NOT dropped; remains PENDING with error recorded
    const outboxId = "obx-cmd-close-fail-sync-memory"
    const writeBackEntry = harness.coordinator.getMemoryWriteBack(outboxId)
    expect(writeBackEntry).toBeDefined()
    expect(writeBackEntry!.status).toBe("pending")
    expect(writeBackEntry!.attempts).toBe(1)
    expect(writeBackEntry!.lastError).toContain("Memory disk buffer I/O failure")
    expect(harness.failedOutboxIds).toContain(outboxId)
    expect(harness.acknowledgedOutboxIds).not.toContain(outboxId)
  })

  it("failed memory write leaves outbox row PENDING with error visible and does not corrupt outcome commit (asynchronous rejection)", async () => {
    const flakyRepo = new FlakyMemoryRepository({ now: () => NOW })
    flakyRepo.shouldFail = true
    flakyRepo.failMode = "reject"

    const harness = createTestHarness({ memoryRepository: flakyRepo })
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

    // Durability review invariant: row is PENDING with error recorded
    const outboxId = "obx-cmd-close-fail-async-memory"
    const writeBackEntry = harness.coordinator.getMemoryWriteBack(outboxId)
    expect(writeBackEntry).toBeDefined()
    expect(writeBackEntry!.status).toBe("pending")
    expect(writeBackEntry!.attempts).toBe(1)
    expect(writeBackEntry!.lastError).toContain("Async network store timeout")
    expect(harness.failedOutboxIds).toContain(outboxId)
    expect(harness.acknowledgedOutboxIds).not.toContain(outboxId)
  })

  it("fail once -> redelivery delivers exactly once (assert one memory record, success marks delivered, no redelivery)", async () => {
    const flakyRepo = new FlakyMemoryRepository({ now: () => NOW })
    flakyRepo.shouldFail = true
    flakyRepo.failMode = "throw"

    const harness = createTestHarness({ memoryRepository: flakyRepo })
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-redeliver"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-redeliver-1",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Redelivery test post",
            createdAt: NOW,
          },
        },
        "cmd-post-redeliver-1",
      ),
    )

    const outcome = makeSampleOutcome()
    const outboxId = "obx-cmd-close-redeliver-memory"

    // 1. Initial attempt fails
    const closeRes = await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-redeliver") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )
    expect(closeRes.ok).toBe(true)

    // Assert row is PENDING and memory store has 0 records
    const beforeSweep = harness.coordinator.getMemoryWriteBack(outboxId)!
    expect(beforeSweep).toBeDefined()
    expect(beforeSweep.status).toBe("pending")
    expect(beforeSweep.attempts).toBe(1)
    expect(beforeSweep.lastError).toContain("Memory disk buffer I/O failure")
    expect(await flakyRepo.listProjectUnscoped(PROJECT)).toHaveLength(0)

    // 2. Unblock repository so subsequent write succeeds
    flakyRepo.shouldFail = false

    // 3. Trigger sweep / redelivery
    const sweepResults = await harness.coordinator.sweepMemoryWriteBacks()
    expect(sweepResults).toHaveLength(1)
    expect(sweepResults[0]).toEqual({
      outboxId,
      status: "delivered",
      attempts: 2,
    })

    // 4. Exactly one memory record was delivered
    const recordsAfterFirstSweep = await flakyRepo.listProjectUnscoped(PROJECT)
    expect(recordsAfterFirstSweep).toHaveLength(1)
    const stored = recordsAfterFirstSweep[0]
    if (!isMemoryRecordV2(stored)) throw new Error("Expected MemoryRecordV2")
    expect(stored.trust).toBe("proposed")
    expect(stored.sourceReferences).toContainEqual({ namespace: "postId", id: "post-redeliver-1" })

    // Row is now marked delivered
    const afterSweep = harness.coordinator.getMemoryWriteBack(outboxId)!
    expect(afterSweep.status).toBe("delivered")
    expect(afterSweep.deliveredAt).toBeDefined()
    expect(afterSweep.lastError).toBeUndefined()
    expect(harness.acknowledgedOutboxIds).toContain(outboxId)

    // 5. Success marks delivered: subsequent sweep does NO redelivery
    const sweepResults2 = await harness.coordinator.sweepMemoryWriteBacks()
    expect(sweepResults2).toHaveLength(0)

    // Still exactly ONE memory record in store (no double write)
    const recordsAfterSecondSweep = await flakyRepo.listProjectUnscoped(PROJECT)
    expect(recordsAfterSecondSweep).toHaveLength(1)
  })

  it("success marks delivered immediately (sweep skips already delivered row, exactly one memory record)", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-healthy"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-healthy-1",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "note",
            body: "Healthy post",
            createdAt: NOW,
          },
        },
        "cmd-post-healthy-1",
      ),
    )

    const outcome = makeSampleOutcome()
    const outboxId = "obx-cmd-close-healthy-memory"

    const closeRes = await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-healthy") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )
    expect(closeRes.ok).toBe(true)

    // Success immediately marks row delivered
    const wb = harness.coordinator.getMemoryWriteBack(outboxId)!
    expect(wb).toBeDefined()
    expect(wb.status).toBe("delivered")
    expect(wb.deliveredAt).toBeDefined()
    expect(wb.lastError).toBeUndefined()
    expect(harness.acknowledgedOutboxIds).toContain(outboxId)

    // Memory store has exactly one record
    expect(await harness.memoryRepository.listProjectUnscoped(PROJECT)).toHaveLength(1)

    // Sweep skips already delivered row
    const sweepResults = await harness.coordinator.sweepMemoryWriteBacks()
    expect(sweepResults).toHaveLength(0)

    // Still exactly one record
    expect(await harness.memoryRepository.listProjectUnscoped(PROJECT)).toHaveLength(1)
  })

  it("redelivery converges idempotently if memory store already has record (duplicate_id)", async () => {
    const harness = createTestHarness()
    const roundtable = makeSampleRoundtable()

    harness.coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-dup-conv"))
    harness.coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-dup-conv-1",
            discussionId: roundtable.id,
            seq: 1,
            authorNodeId: CHAIR_NODE,
            authorRoleId: "chair",
            kind: "proposal",
            body: "Convergence test post",
            createdAt: NOW,
          },
        },
        "cmd-post-dup-conv-1",
      ),
    )

    const outcome = makeSampleOutcome()
    const outboxId = "obx-cmd-close-dup-conv-memory"

    await harness.coordinator.submitClose(
      baseCommand("roundtable.close", { discussionId: roundtable.id, outcome }, "cmd-close-dup-conv") as Extract<OrchestrationCommand, { type: "roundtable.close" }>,
    )

    // Manually simulate ambiguous crash window: record is in memory store, but outbox row reverted to pending
    const entry = harness.coordinator.getMemoryWriteBack(outboxId)!
    expect(entry.status).toBe("delivered")
    entry.status = "pending"

    // Sweep attempts to re-append, memory repository returns duplicate_id, sweep converges
    const sweepResults = await harness.coordinator.sweepMemoryWriteBacks()
    expect(sweepResults).toHaveLength(1)
    expect(sweepResults[0]).toEqual({
      outboxId,
      status: "delivered",
      attempts: 2,
    })

    // Marked delivered again and still exactly one record
    expect(entry.status).toBe("delivered")
    expect(await harness.memoryRepository.listProjectUnscoped(PROJECT)).toHaveLength(1)
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

  describe("Restart Safety & Durable Outbox Discipline (real-File SQLite)", () => {
    it("append roundtable.close -> new coordinator instance over same store/driver -> sweepMemoryWriteBacks delivers exactly once, second sweep is silent", async () => {
      const db = durable("writeback-restart-clean")
      try {
        const store1 = new SqliteEventStore(db.driver)
        let seq1 = 0
        const coordinator1 = new DispatchCoordinator({
          log: store1,
          now: () => NOW,
          newEventId: () => `evt-res-${++seq1}`,
          readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
          roundtables: new RoundtableRepository(),
          memoryRepository: undefined,
        })

        const roundtable = makeSampleRoundtable({ id: "disc-restart-1" })
        const openRes = coordinator1.submit(
          baseCommand("roundtable.open", { roundtable }, "cmd-open-restart-1"),
        )
        expect(openRes.ok).toBe(true)

        const postRes = coordinator1.submit(
          baseCommand(
            "roundtable.post",
            {
              post: {
                postId: "post-restart-1",
                discussionId: roundtable.id,
                seq: 1,
                authorNodeId: CHAIR_NODE,
                authorRoleId: "chair",
                kind: "proposal",
                body: "Durable write-back restart post",
                createdAt: NOW,
              },
            },
            "cmd-post-restart-1",
          ),
        )
        expect(postRes.ok).toBe(true)

        const outcome = makeSampleOutcome()
        const outboxId = "obx-cmd-close-restart-1-memory"
        const closeCmd: OrchestrationCommand = baseCommand(
          "roundtable.close",
          { discussionId: roundtable.id, outcome },
          "cmd-close-restart-1",
        )
        const closeRes = coordinator1.submit(closeCmd)
        expect(closeRes.ok).toBe(true)

        // Durable row is committed in SQLite with status 'pending'
        const committedRow = store1.getOutboxRecord(outboxId)
        expect(committedRow).toBeDefined()
        expect(committedRow?.destination).toBe(MEMORY_WRITEBACK_DESTINATION)
        expect(committedRow?.status).toBe("pending")
        expect(committedRow?.attempts).toBe(0)

        // Shutdown / crash process 1
        db.close()

        // Restart process: reopen existing database file (not :memory:)
        const reopened = reopen(db.path)
        try {
          const store2 = new SqliteEventStore(reopened.driver)
          const memoryRepo = new InMemoryMemoryRepository({ now: () => NOW })
          let seq2 = 0
          const coordinator2 = new DispatchCoordinator({
            log: store2,
            now: () => NOW,
            newEventId: () => `evt-res-${++seq2}`,
            readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
            roundtables: new RoundtableRepository(),
            memoryRepository: memoryRepo,
          })

          // In-memory map is initially empty, but durable store has row
          expect(await memoryRepo.listProjectUnscoped(PROJECT)).toHaveLength(0)
          const durableRow = coordinator2.getMemoryWriteBack(outboxId)
          expect(durableRow).toBeDefined()
          expect(durableRow?.status).toBe("pending")

          // Sweep delivers the committed outbox row
          const sweepResults1 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults1).toHaveLength(1)
          expect(sweepResults1[0]).toEqual({
            outboxId,
            status: "delivered",
            attempts: 1,
          })

          // Exactly one memory record was delivered with correct provenance
          const storedRecords = await memoryRepo.listProjectUnscoped(PROJECT)
          expect(storedRecords).toHaveLength(1)
          const rec = storedRecords[0]
          if (!isMemoryRecordV2(rec)) throw new Error("Expected MemoryRecordV2")
          expect(rec.trust).toBe("proposed")
          expect(rec.sourceReferences).toContainEqual({
            namespace: "postId",
            id: "post-restart-1",
          })

          // Row in SQLite is now acknowledged
          const acknowledgedRow = store2.getOutboxRecord(outboxId)
          expect(acknowledgedRow?.status).toBe("acknowledged")

          // Second sweep delivers nothing (silent)
          const sweepResults2 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults2).toHaveLength(0)

          // Still exactly one memory record (no double-write)
          expect(await memoryRepo.listProjectUnscoped(PROJECT)).toHaveLength(1)
        } finally {
          reopened.remove()
        }
      } finally {
        db.remove()
      }
    })

    it("failure in process 1 preserves attempts and lastError on durable row across restart; new coordinator sweep delivers exactly once", async () => {
      const db = durable("writeback-restart-fail")
      try {
        const store1 = new SqliteEventStore(db.driver)
        const flakyRepo = new FlakyMemoryRepository({ now: () => NOW })
        flakyRepo.shouldFail = true
        flakyRepo.failMode = "throw"

        let seq1 = 0
        const coordinator1 = new DispatchCoordinator({
          log: store1,
          now: () => NOW,
          newEventId: () => `evt-fail-${++seq1}`,
          readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
          roundtables: new RoundtableRepository(),
          memoryRepository: flakyRepo,
        })

        const roundtable = makeSampleRoundtable({ id: "disc-restart-fail-1" })
        coordinator1.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-fail-1"))
        coordinator1.submit(
          baseCommand(
            "roundtable.post",
            {
              post: {
                postId: "post-fail-1",
                discussionId: roundtable.id,
                seq: 1,
                authorNodeId: CHAIR_NODE,
                authorRoleId: "chair",
                kind: "proposal",
                body: "Failure test post",
                createdAt: NOW,
              },
            },
            "cmd-post-fail-1",
          ),
        )

        const outcome = makeSampleOutcome()
        const outboxId = "obx-cmd-close-fail-1-memory"
        const closeCmd = baseCommand(
          "roundtable.close",
          { discussionId: roundtable.id, outcome },
          "cmd-close-fail-1",
        ) as Extract<OrchestrationCommand, { type: "roundtable.close" }>

        const closeRes = await coordinator1.submitClose(closeCmd)
        expect(closeRes.ok).toBe(true)

        // Attempt 1 failed; failure and attempt count are committed on durable row
        const rowInStore1 = store1.getOutboxRecord(outboxId)
        expect(rowInStore1).toBeDefined()
        expect(rowInStore1?.status).toBe("pending")
        expect(rowInStore1?.attempts).toBe(1)
        expect(rowInStore1?.lastError).toContain("Memory disk buffer I/O failure")
        expect(await flakyRepo.listProjectUnscoped(PROJECT)).toHaveLength(0)

        // Crash/close process 1
        db.close()

        // Restart process: reopen existing SQLite file
        const reopened = reopen(db.path)
        try {
          const store2 = new SqliteEventStore(reopened.driver)
          const workingRepo = new InMemoryMemoryRepository({ now: () => NOW })
          let seq2 = 0
          const coordinator2 = new DispatchCoordinator({
            log: store2,
            now: () => NOW,
            newEventId: () => `evt-fail-${++seq2}`,
            readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
            roundtables: new RoundtableRepository(),
            memoryRepository: workingRepo,
          })

          // Durable state survived restart
          const beforeSweep = coordinator2.getMemoryWriteBack(outboxId)
          expect(beforeSweep).toBeDefined()
          expect(beforeSweep?.status).toBe("pending")
          expect(beforeSweep?.attempts).toBe(1)
          expect(beforeSweep?.lastError).toContain("Memory disk buffer I/O failure")

          // Sweep delivers; attempts increments to 2
          const sweepResults1 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults1).toHaveLength(1)
          expect(sweepResults1[0]).toEqual({
            outboxId,
            status: "delivered",
            attempts: 2,
          })

          // Exactly one memory record delivered
          const records = await workingRepo.listProjectUnscoped(PROJECT)
          expect(records).toHaveLength(1)

          // Row in SQLite is now acknowledged
          expect(store2.getOutboxRecord(outboxId)?.status).toBe("acknowledged")

          // Second sweep delivers nothing
          const sweepResults2 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults2).toHaveLength(0)
          expect(await workingRepo.listProjectUnscoped(PROJECT)).toHaveLength(1)
        } finally {
          reopened.remove()
        }
      } finally {
        db.remove()
      }
    })

    it("duplicate convergence across restart: record already in memory store converges idempotently (duplicate_id), exactly one record", async () => {
      const db = durable("writeback-restart-dup")
      try {
        const store1 = new SqliteEventStore(db.driver)
        const memoryRepo = new InMemoryMemoryRepository({ now: () => NOW })
        let seq1 = 0
        const coordinator1 = new DispatchCoordinator({
          log: store1,
          now: () => NOW,
          newEventId: () => `evt-dup-${++seq1}`,
          readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
          roundtables: new RoundtableRepository(),
          memoryRepository: memoryRepo,
        })

        const roundtable = makeSampleRoundtable({ id: "disc-restart-dup-1" })
        coordinator1.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-dup-1"))
        coordinator1.submit(
          baseCommand(
            "roundtable.post",
            {
              post: {
                postId: "post-dup-1",
                discussionId: roundtable.id,
                seq: 1,
                authorNodeId: CHAIR_NODE,
                authorRoleId: "chair",
                kind: "proposal",
                body: "Dup test post",
                createdAt: NOW,
              },
            },
            "cmd-post-dup-1",
          ),
        )

        const outcome = makeSampleOutcome()
        const outboxId = "obx-cmd-close-dup-1-memory"
        const closeCmd = baseCommand(
          "roundtable.close",
          { discussionId: roundtable.id, outcome },
          "cmd-close-dup-1",
        ) as Extract<OrchestrationCommand, { type: "roundtable.close" }>

        await coordinator1.submitClose(closeCmd)
        expect(await memoryRepo.listProjectUnscoped(PROJECT)).toHaveLength(1)

        // Simulate ambiguous crash window: record is durable in memory repo, but outbox row reverted to pending
        db.driver.run(
          "UPDATE outbox_records SET status = 'pending', acknowledged_at = NULL WHERE outbox_id = ?",
          outboxId,
        )

        db.close()

        // Restart process
        const reopened = reopen(db.path)
        try {
          const store2 = new SqliteEventStore(reopened.driver)
          let seq2 = 0
          const coordinator2 = new DispatchCoordinator({
            log: store2,
            now: () => NOW,
            newEventId: () => `evt-dup-${++seq2}`,
            readRun: (runId) => (runId === RUN ? makeRunProjection() : undefined),
            roundtables: new RoundtableRepository(),
            memoryRepository: memoryRepo,
          })

          // Sweep encounters memory.duplicate_id, converges, marks delivered
          const sweepResults1 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults1).toHaveLength(1)
          expect(sweepResults1[0].status).toBe("delivered")

          // Still exactly one memory record in store (no double write)
          expect(await memoryRepo.listProjectUnscoped(PROJECT)).toHaveLength(1)

          // Second sweep delivers nothing
          const sweepResults2 = await coordinator2.sweepMemoryWriteBacks()
          expect(sweepResults2).toHaveLength(0)
          expect(await memoryRepo.listProjectUnscoped(PROJECT)).toHaveLength(1)
        } finally {
          reopened.remove()
        }
      } finally {
        db.remove()
      }
    })
  })
})

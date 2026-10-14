import { describe, expect, it } from "vitest"
import { BudgetLedger } from "../../../src/budgets/ledger.js"
import {
  RoundtableRepository,
  type Roundtable,
} from "../../../src/orchestration/roundtable/index.js"
import { DispatchCoordinator } from "../../../src/orchestration/coordinator/coordinator.js"
import { CharterRepository } from "../../../src/orchestration/charter/repository.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../../src/orchestration/policy/immutable-core.js"
import { computeCharterSnapshotDigest } from "../../../src/orchestration/schemas.js"
import type { Charter } from "../../../src/orchestration/charter/types.js"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "../../../src/orchestration/identifiers.js"
import type { OrchestrationCommand } from "../../../src/orchestration/types.js"
import { reduceEvent } from "../../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"

const PROJECT = projectIdSchema.parse("proj-budget-test")
const RUN = runIdSchema.parse("run-budget-test")
const NOW = "2026-10-14T12:00:00.000Z"
const LATER = "2026-10-14T13:00:00.000Z"
const ACTOR = { kind: "node" as const, nodeId: nodeIdSchema.parse("node-chair") }

function makeTestCharter(budgetScope: "shared" | "per_member", maxRounds = 5): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId: PROJECT,
    version: 1,
    purpose: "Testing roundtable fan-out budgets",
    globalRules: ["rule 1"],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: [],
      verbosity: "normal" as const,
      mustStopAndAsk: [],
      objectionMustContain: ["rationale"],
    },
    escalationPolicy: {
      maxRounds,
      onDeadlock: "chair_decides" as const,
      budgetScope,
    },
    roleCatalog: [{ roleId: "chair-role", version: 1 }],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}` as const,
    author: "human" as const,
    capturedAt: NOW,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function baseCommand<T extends OrchestrationCommand["type"] = OrchestrationCommand["type"]>(
  type: T,
  payload: unknown,
  commandId = `cmd-${type}-1`,
): Extract<OrchestrationCommand, { type: T }> {
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(commandId),
    type,
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: nodeIdSchema.parse("node-chair"),
    controllerEpoch: epochSchema.parse(1),
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: LATER,
    correlationId: correlationIdSchema.parse("corr-1"),
    causation: null,
    payload,
  } as unknown as Extract<OrchestrationCommand, { type: T }>
}

function makeRunProjection(): RunProjectionState {
  const runCreated = {
    schemaVersion: 1,
    eventId: "seed-1",
    sequence: 1,
    type: "run.created",
    projectId: PROJECT,
    runId: RUN,
    occurredAt: NOW,
    actor: ACTOR,
    controllerEpoch: 1,
    correlationId: "corr-1",
    causation: null,
    payload: {
      run: {
        schemaVersion: 1,
        runId: RUN,
        projectId: PROJECT,
        goal: "test goal",
        state: "active",
        paused: false,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
    },
  }
  return reduceEvent(null, runCreated as never)
}

describe("Phase 5 — Roundtable fan-out budget gating", () => {
  it("enforces ledger maximumFanOut ceiling on parallel roundtable fan-out and refuses beyond ceiling", () => {
    const ledger = new BudgetLedger({
      resolveLimits: () => ({ maximumFanOut: 2 }),
    })
    const roundtables = new RoundtableRepository()
    const charters = new CharterRepository()
    charters.registerCharter(makeTestCharter("shared"))

    let eventSeq = 0
    const projection = makeRunProjection()
    const coordinator = new DispatchCoordinator({
      log: {
        append: (opts) => ({ duplicate: false, events: opts.events }),
      },
      now: () => NOW,
      newEventId: () => `evt-${++eventSeq}`,
      readRun: (runId) => (runId === RUN ? projection : undefined),
      roundtables,
      charters,
      budgetLedger: ledger,
    })

    // Open parallel roundtable with 4 members (1 author + 3 recipients = fanOut of 3)
    const roundtable: Roundtable = {
      id: "disc-fanout-1",
      runId: RUN,
      taskId: taskIdSchema.parse("task-fanout-1"),
      subject: "Parallel deliberation",
      mode: "parallel",
      chairNodeId: nodeIdSchema.parse("node-chair"),
      members: [
        { nodeId: nodeIdSchema.parse("node-chair"), roleId: "chair-role" },
        { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "role-a" },
        { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "role-b" },
        { nodeId: nodeIdSchema.parse("node-worker-c"), roleId: "role-c" },
      ],
      state: "open",
    }
    const openRes = coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-1"))
    expect(openRes.ok).toBe(true)

    // Posting from chair would fan out to 3 recipient nodes, exceeding ceiling 2 -> refused
    const postRes = coordinator.submit(
      baseCommand(
        "roundtable.post",
        {
          post: {
            postId: "post-1",
            discussionId: "disc-fanout-1",
            authorNodeId: nodeIdSchema.parse("node-chair"),
            authorRoleId: "chair-role",
            kind: "proposal",
            body: "Exceeding fan-out proposal",
            createdAt: NOW,
          },
        },
        "cmd-post-1",
      ),
    )

    expect(postRes.ok).toBe(false)
    if (!postRes.ok) {
      expect(postRes.error.code).toBe("budget.scope_saturated")
      expect(postRes.error.category).toBe("policy_denied")
    }
  })

  it("honours budgetScope: 'shared' vs 'per_member' and produces the documented different counters", () => {
    // 1. SHARED SCOPE TEST
    {
      const ledger = new BudgetLedger({
        resolveLimits: () => ({ maximumFanOut: 4 }),
      })
      const roundtables = new RoundtableRepository()
      const charters = new CharterRepository()
      charters.registerCharter(makeTestCharter("shared"))

      let eventSeq = 0
      const projection = makeRunProjection()
      const coordinator = new DispatchCoordinator({
        log: { append: (opts) => ({ duplicate: false, events: opts.events }) },
        now: () => NOW,
        newEventId: () => `evt-${++eventSeq}`,
        readRun: (runId) => (runId === RUN ? projection : undefined),
        roundtables,
        charters,
        budgetLedger: ledger,
      })

      // 3 members: author + 2 recipients = 2 units per post
      const roundtable: Roundtable = {
        id: "disc-shared-1",
        runId: RUN,
        taskId: taskIdSchema.parse("task-shared-1"),
        subject: "Shared deliberation",
        mode: "parallel",
        chairNodeId: nodeIdSchema.parse("node-chair"),
        members: [
          { nodeId: nodeIdSchema.parse("node-chair"), roleId: "chair-role" },
          { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "role-a" },
          { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "role-b" },
        ],
        state: "open",
      }
      coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-shared"))

      // First post from chair (2 units) -> proceeds
      const post1 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-s-1",
              discussionId: "disc-shared-1",
              authorNodeId: nodeIdSchema.parse("node-chair"),
              authorRoleId: "chair-role",
              kind: "proposal",
              body: "First post",
              createdAt: NOW,
            },
          },
          "cmd-post-s-1",
        ),
      )
      expect(post1.ok).toBe(true)

      // Second post from worker-a (2 units) -> total 4 of ceiling 4 -> proceeds
      const post2 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-s-2",
              discussionId: "disc-shared-1",
              authorNodeId: nodeIdSchema.parse("node-worker-a"),
              authorRoleId: "role-a",
              kind: "objection",
              body: "Second post",
              createdAt: NOW,
            },
          },
          "cmd-post-s-2",
        ),
      )
      expect(post2.ok).toBe(true)

      // Assert shared counter holds 4 units under the discussion subScope
      expect(ledger.heldUnits(PROJECT, "fan_out", "roundtable:disc-shared-1")).toBe(4)

      // Third post from worker-b (2 units) -> total 4 + 2 = 6 > 4 -> refused
      const post3 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-s-3",
              discussionId: "disc-shared-1",
              authorNodeId: nodeIdSchema.parse("node-worker-b"),
              authorRoleId: "role-b",
              kind: "question",
              body: "Third post",
              createdAt: NOW,
            },
          },
          "cmd-post-s-3",
        ),
      )
      expect(post3.ok).toBe(false)
      if (!post3.ok) {
        expect(post3.error.code).toBe("budget.scope_saturated")
      }
    }

    // 2. PER_MEMBER SCOPE TEST
    {
      const ledger = new BudgetLedger({
        resolveLimits: () => ({ maximumFanOut: 4 }),
      })
      const roundtables = new RoundtableRepository()
      const charters = new CharterRepository()
      charters.registerCharter(makeTestCharter("per_member"))

      let eventSeq = 0
      const projection = makeRunProjection()
      const coordinator = new DispatchCoordinator({
        log: { append: (opts) => ({ duplicate: false, events: opts.events }) },
        now: () => NOW,
        newEventId: () => `evt-${++eventSeq}`,
        readRun: (runId) => (runId === RUN ? projection : undefined),
        roundtables,
        charters,
        budgetLedger: ledger,
      })

      // 3 members: author + 2 recipients = 2 units per post
      const roundtable: Roundtable = {
        id: "disc-member-1",
        runId: RUN,
        taskId: taskIdSchema.parse("task-member-1"),
        subject: "Per-member deliberation",
        mode: "parallel",
        chairNodeId: nodeIdSchema.parse("node-chair"),
        members: [
          { nodeId: nodeIdSchema.parse("node-chair"), roleId: "chair-role" },
          { nodeId: nodeIdSchema.parse("node-worker-a"), roleId: "role-a" },
          { nodeId: nodeIdSchema.parse("node-worker-b"), roleId: "role-b" },
        ],
        state: "open",
      }
      coordinator.submit(baseCommand("roundtable.open", { roundtable }, "cmd-open-member"))

      // Member chair posts twice (2 units each = 4 units for chair)
      const postChair1 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-m-c1",
              discussionId: "disc-member-1",
              authorNodeId: nodeIdSchema.parse("node-chair"),
              authorRoleId: "chair-role",
              kind: "proposal",
              body: "Chair post 1",
              createdAt: NOW,
            },
          },
          "cmd-post-m-c1",
        ),
      )
      expect(postChair1.ok).toBe(true)

      const postChair2 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-m-c2",
              discussionId: "disc-member-1",
              authorNodeId: nodeIdSchema.parse("node-chair"),
              authorRoleId: "chair-role",
              kind: "note",
              body: "Chair post 2",
              createdAt: NOW,
            },
          },
          "cmd-post-m-c2",
        ),
      )
      expect(postChair2.ok).toBe(true)

      // Chair counter is now at ceiling 4
      expect(ledger.heldUnits(PROJECT, "fan_out", "roundtable:disc-member-1:node-chair")).toBe(4)

      // Chair third post would exceed chair's ceiling 4 -> refused for chair
      const postChair3 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-m-c3",
              discussionId: "disc-member-1",
              authorNodeId: nodeIdSchema.parse("node-chair"),
              authorRoleId: "chair-role",
              kind: "note",
              body: "Chair post 3",
              createdAt: NOW,
            },
          },
          "cmd-post-m-c3",
        ),
      )
      expect(postChair3.ok).toBe(false)
      if (!postChair3.ok) {
        expect(postChair3.error.code).toBe("budget.scope_saturated")
      }

      // But worker-a has a SEPARATE member counter (currently 0), so worker-a post proceeds!
      const postWorkerA1 = coordinator.submit(
        baseCommand(
          "roundtable.post",
          {
            post: {
              postId: "post-m-a1",
              discussionId: "disc-member-1",
              authorNodeId: nodeIdSchema.parse("node-worker-a"),
              authorRoleId: "role-a",
              kind: "objection",
              body: "Worker A post 1",
              createdAt: NOW,
            },
          },
          "cmd-post-m-a1",
        ),
      )
      expect(postWorkerA1.ok).toBe(true)

      // Assert the actual counter split between members:
      // Chair counter is 4, Worker-a counter is 2, Worker-b counter is 0
      expect(ledger.heldUnits(PROJECT, "fan_out", "roundtable:disc-member-1:node-chair")).toBe(4)
      expect(ledger.heldUnits(PROJECT, "fan_out", "roundtable:disc-member-1:node-worker-a")).toBe(2)
      expect(ledger.heldUnits(PROJECT, "fan_out", "roundtable:disc-member-1:node-worker-b")).toBe(0)

      // And dispatch fan_out counter remains 0 (separate counters per P1 discipline)
      expect(ledger.heldUnits(PROJECT, "fan_out")).toBe(0)
    }
  })
})

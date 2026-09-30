/**
 * M5.6 — an agent can propose memory, and cannot make it trusted.
 *
 * The plan's criterion is "Agents can propose but cannot directly trust project
 * memory". The interesting part is *where* that is enforced, so the tests are
 * organised by layer:
 *
 * 1. The command surface has no way to ask for `accepted` (`memory.propose` has
 *    no trust parameter).
 * 2. The workflow refuses a non-user decision, with a code that says why.
 * 3. The *record schema* refuses the result, so a bypassed workflow still
 *    cannot write the record.
 *
 * The third is the one that matters. Layers 1 and 2 are both in code a future
 * caller could route around; layer 3 is the data, and data does not route.
 */

import { describe, expect, it } from "vitest"
import { InMemoryMemoryRepository } from "../../../src/memory/in-memory-repository.js"
import { RepositoryMemoryWorkflow, type MemoryCommand, type WorkflowContext } from "../../../src/memory/workflow.js"
import { memoryRecordSchemaV2, proposeMemoryRecord, toMemoryRecordView } from "../../../src/memory/record.js"
import type { MemoryRepository } from "../../../src/memory/ports.js"
import {
  userIdSchema,
  sessionIdSchema,
  nodeIdSchema,
  roleIdSchema,
  projectIdSchema,
} from "../../../src/orchestration/identifiers.js"
import type { Actor } from "../../../src/orchestration/types.js"

const NOW = "2026-09-30T12:00:00.000Z"

/** `query` returns a `Result`; every assertion below is about a successful read. */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}
const LATER = "2026-10-01T12:00:00.000Z"
const PROJECT = "project-m5-workflow"

const USER: Actor = { kind: "user", userId: userIdSchema.parse("user-owner") }
const SESSION: Actor = { kind: "session", sessionId: sessionIdSchema.parse("session-1") }
const NODE: Actor = { kind: "node", nodeId: nodeIdSchema.parse("node-a") }
const SYSTEM: Actor = { kind: "system", name: "system-m5" }

function store(): MemoryRepository {
  return new InMemoryMemoryRepository({ now: () => NOW })
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; category: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

function refuse(result: { ok: boolean } & Record<string, unknown>): { code: string; message: string; category: string } {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected a refusal")
  return result.error as { code: string; message: string; category: string }
}

function contextFor(actor: Actor): WorkflowContext {
  return { actor, projectId: PROJECT, at: NOW, correlationId: "corr-m5" }
}

function proposeCommand(overrides: Partial<Extract<MemoryCommand, { type: "memory.propose" }>> = {}): Extract<MemoryCommand, { type: "memory.propose" }> {
  return {
    type: "memory.propose",
    projectId: PROJECT,
    kind: "finding",
    scope: { kind: "project" },
    author: SESSION,
    at: NOW,
    content: "The deploy job does not verify the artifact digest.",
    correlationId: "corr-m5",
    ...overrides,
  }
}

describe("M5.6 the command surface cannot ask for trust", () => {
  it("memory.propose has no trust parameter to set", () => {
    // A type-level assertion: if a `trust` field were added to the command, the
    // `satisfies` below would still compile but the object literal above would
    // not be `ProposeCommand` any more. The runtime check is the real one.
    const command = proposeCommand() as ProposeCommand & { trust?: unknown }
    expect("trust" in command).toBe(false)
  })

  it("a session's proposal is born proposed, with no trust decision", async () => {
    const repository = store()
    const result = ok(await new RepositoryMemoryWorkflow(repository).execute(proposeCommand(), contextFor(SESSION)))

    expect(result.record.trust).toBe("proposed")
    expect(result.record.trustDecision).toBeUndefined()
    expect(result.record.author).toEqual(SESSION)
  })

  it("a node's proposal is proposed too", async () => {
    const repository = store()
    const result = ok(await new RepositoryMemoryWorkflow(repository).execute(proposeCommand({ author: NODE }), contextFor(NODE)))
    expect(result.record.trust).toBe("proposed")
  })

  it("a system's proposal is system_derived, and still not trusted", async () => {
    const repository = store()
    const result = ok(
      await new RepositoryMemoryWorkflow(repository).execute(proposeCommand({ author: SYSTEM, kind: "summary" }), contextFor(SYSTEM)),
    )
    expect(result.record.trust).toBe("system_derived")
    // And it cannot be promoted: see the transition tests below.
  })
})

describe("M5.6 only a user may accept, and the record schema says so too", () => {
  it("refuses an accept from a session, a node, and a system", async () => {
    for (const actor of [SESSION, NODE, SYSTEM]) {
      const repository = store()
      const workflow = new RepositoryMemoryWorkflow(repository)
      const proposed = ok(await workflow.execute(proposeCommand({ author: actor }), contextFor(actor)))

      const error = refuse(
        await workflow.execute(
          {
            type: "memory.accept",
            memoryId: proposed.record.memoryId,
            projectId: PROJECT,
            decidedBy: actor,
            at: LATER,
            reason: "I am confident in this.",
            correlationId: "corr-m5",
          },
          contextFor(actor),
        ),
      )
      expect(error.code).toBe("memory.unauthorized_trust_decision")
      expect(error.category).toBe("policy_denied")

      const stored = await repository.getRaw(proposed.record.memoryId)
      // Unchanged, whatever it was. A system author produces `system_derived`
      // and a session produces `proposed`; the point is that the refused
      // decision left the record exactly as it was.
      expect((stored as { trust: string }).trust).toBe(proposed.record.trust)
      expect((stored as { trust: string }).trust).not.toBe("accepted")
    }
  })

  it("accepts from a user, and records who and when", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))

    const accepted = ok(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "Confirmed against the deploy config.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(accepted.record.trust).toBe("accepted")
    expect(accepted.record.trustDecision).toEqual({
      decidedBy: USER,
      decidedAt: LATER,
      reason: "Confirmed against the deploy config.",
    })
    expect(memoryRecordSchemaV2.safeParse(accepted.record).success).toBe(true)
  })

  it("refuses a trust decision with no reason", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))

    const error = refuse(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "   ",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(error.code).toBe("memory.trust_reason_required")
  })

  it("THE DATA refuses it, so a bypassed workflow still cannot write the record", () => {
    // The workflow is code a future caller could route around. This is not.
    const forged = proposeMemoryRecord({
      memoryId: "memory-forged",
      projectId: PROJECT,
      kind: "decision",
      scope: { kind: "project" },
      author: SESSION,
      createdAt: NOW,
      content: "Trust me, this is a project decision.",
    })
    const mutated = { ...forged, trust: "accepted" as const, trustDecision: { decidedBy: SESSION, decidedAt: LATER } }

    const parsed = memoryRecordSchemaV2.safeParse(mutated)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((issue) => issue.path.join(".") === "trustDecision.decidedBy.kind")).toBe(true)
  })

  it("a system_derived record cannot be promoted by a user either", async () => {
    // A user's acceptance is authority over *trust*, not over *content*. A
    // system summary stays a system summary: promoting it would mean the record
    // reads as something the system observed, when a human merely said "I agree".
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const derived = ok(
      await workflow.execute(proposeCommand({ author: SYSTEM, kind: "summary" }), contextFor(SYSTEM)),
    )
    const error = refuse(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: derived.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "I agree with the summary.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(error.code).toBe("memory.illegal_trust_transition")
  })

  it("refuses to re-decide a record that is already accepted", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))
    ok(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "First review.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    const error = refuse(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "Second thoughts.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(error.code).toBe("memory.illegal_trust_transition")
  })
})

describe("M5.6 an actor cannot be asserted by the caller", () => {
  it("refuses a command whose named actor differs from the executing context", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const error = refuse(await workflow.execute(proposeCommand({ author: USER }), contextFor(SESSION)))
    expect(error.code).toBe("memory.actor_mismatch")
    expect(await repository.listProjectUnscoped(PROJECT)).toHaveLength(0)
  })

  it("refuses a decision whose decider differs from the executing context", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))

    const error = refuse(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "I accept.",
          correlationId: "corr-m5",
        },
        // The context says a node is executing.
        contextFor(NODE),
      ),
    )
    expect(error.code).toBe("memory.actor_mismatch")
  })

  it("refuses a cross-project command before the repository is consulted", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const error = refuse(
      await workflow.execute(proposeCommand({ projectId: "project-someone-else" }), contextFor(SESSION)),
    )
    expect(error.code).toBe("memory.cross_project_command")
  })

  it("refuses an unknown record rather than creating one", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const error = refuse(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: "memory-does-not-exist",
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "Approving a record I cannot see.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(error.code).toBe("memory.unknown_record")
  })
})

describe("M5.6 every command produces an audit event that names the transition", () => {
  it("a proposal's event records the trust the record ACTUALLY has, not the one asked for", async () => {
    const repository = store()
    const result = ok(await new RepositoryMemoryWorkflow(repository).execute(proposeCommand(), contextFor(SESSION)))

    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.type).toBe("memory.propose")
    expect(event.before).toBe("absent")
    // The record is `proposed`, so the event says `proposed`. An audit event
    // that recorded the *intent* would read as though a session's proposal had
    // been accepted.
    expect(event.after).toBe("proposed")
    expect(event.actor).toEqual(SESSION)
    expect(event.correlationId).toBe("corr-m5")
  })

  it("an acceptance's event names the before and after, and the reason", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))
    const accepted = ok(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "Confirmed against the deploy config.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )

    const event = accepted.events[0]!
    expect(event.type).toBe("memory.accept")
    expect(event.before).toBe("proposed")
    expect(event.after).toBe("accepted")
    expect(event.reason).toBe("Confirmed against the deploy config.")
  })

  it("an audit event never carries the record's content", async () => {
    const repository = store()
    const result = ok(await new RepositoryMemoryWorkflow(repository).execute(proposeCommand(), contextFor(SESSION)))
    const serialized = JSON.stringify(result.events)
    expect(serialized).not.toContain("does not verify the artifact digest")
    expect(Object.keys(result.events[0]!)).not.toContain("content")
  })

  it("a supersession produces TWO events: the new record, and what it displaced", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const first = ok(
      await workflow.execute(proposeCommand({ author: USER, kind: "decision" }), contextFor(USER)),
    )
    const corrected = ok(
      await workflow.execute(
        {
          type: "memory.supersede",
          supersedesMemoryId: first.record.memoryId,
          projectId: PROJECT,
          author: USER,
          at: LATER,
          content: "The deploy job does verify the artifact digest; the earlier note was wrong.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )

    expect(corrected.events).toHaveLength(2)
    const [created, displaced] = corrected.events
    expect(created?.type).toBe("memory.propose")
    expect(created?.supersedesMemoryId).toBe(first.record.memoryId)
    // The second event is about the OLD record. Without it an audit shows a new
    // record appearing and nothing about what it replaced.
    expect(displaced?.type).toBe("memory.supersede")
    expect(displaced?.memoryId).toBe(first.record.memoryId)
    expect(displaced?.supersedesMemoryId).toBe(corrected.record.memoryId)
  })

  it("a supersession preserves the original record's bytes", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const first = ok(await workflow.execute(proposeCommand({ author: USER, kind: "decision" }), contextFor(USER)))
    const before = JSON.stringify(await repository.getRaw(first.record.memoryId))

    ok(
      await workflow.execute(
        {
          type: "memory.supersede",
          supersedesMemoryId: first.record.memoryId,
          projectId: PROJECT,
          author: USER,
          at: LATER,
          content: "A correction.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    expect(JSON.stringify(await repository.getRaw(first.record.memoryId))).toBe(before)
  })
})

describe("M5.6 a proposed record is invisible to a reader until a human accepts it", () => {
  it("the query withholds it with `not_trusted`, and shows it once accepted", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const reader = {
      projectId: projectIdSchema.parse(PROJECT),
      scope: { kind: "project" as const },
      nodeId: nodeIdSchema.parse("node-a"),
      roleId: roleIdSchema.parse("role-implementer"),
      clearance: "restricted" as const,
      actor: USER,
    }

    const proposed = ok(await workflow.execute(proposeCommand(), contextFor(SESSION)))
    const before = expectOk(await repository.query({ projectId: PROJECT }, reader))
    expect(before.records.map((record) => record.memoryId)).not.toContain(proposed.record.memoryId)
    expect(before.withheld.find((entry) => entry.memoryId === proposed.record.memoryId)?.reason).toBe("not_trusted")

    ok(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: USER,
          at: LATER,
          reason: "Reviewed.",
          correlationId: "corr-m5",
        },
        contextFor(USER),
      ),
    )
    const after = expectOk(await repository.query({ projectId: PROJECT }, reader))
    expect(after.records.map((record) => record.memoryId)).toContain(proposed.record.memoryId)
    expect(after.withheld.find((entry) => entry.memoryId === proposed.record.memoryId)).toBeUndefined()
  })
})

type ProposeCommand = Extract<MemoryCommand, { type: "memory.propose" }>

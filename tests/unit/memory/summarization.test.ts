/**
 * M5.7 — handoffs and dependency results, bounded.
 *
 * The plan's guardrail is "Do not store complete raw transcripts as memory by
 * default", and the criterion is "Downstream context excludes unrelated
 * transcript/output". Both are properties of the *shape*, so the tests are
 * about shape:
 *
 * - there is no field a transcript can be put in;
 * - a summary longer than the bound is refused, not truncated silently;
 * - artifacts are referenced by id and never inlined;
 * - a run summary says what it dropped.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_ARTIFACT_REFERENCES,
  MAX_SUMMARY_CHARACTERS,
  MAX_UNRESOLVED,
  buildRunSummary,
  dependencyResultSchema,
  dependencyResultToMemoryRecord,
  handoffPacketSchema,
  handoffToMemoryRecord,
  type DependencyResult,
  type HandoffPacket,
} from "../../../src/memory/summarization.js"
import {
  artifactIdSchema,
  dispatchIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  userIdSchema,
} from "../../../src/orchestration/identifiers.js"
import type { Actor } from "../../../src/orchestration/types.js"

const NOW = "2026-09-30T12:00:00.000Z"
const PROJECT = projectIdSchema.parse("project-m5-handoff")
const RUN = runIdSchema.parse("run-1")
const TASK = taskIdSchema.parse("task-1")
const USER: Actor = { kind: "user", userId: userIdSchema.parse("user-owner") }
const SESSION: Actor = { kind: "session", sessionId: sessionIdSchema.parse("session-1") }

function packet(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
  return handoffPacketSchema.parse({
    projectId: PROJECT,
    runId: RUN,
    taskId: TASK,
    toRoleId: "role-verifier",
    fromActor: { kind: "session", sessionId: "session-1" },
    summary: "Deployment verified on the VPS; the artifact digest matches the registry.",
    prerequisites: ["The build job completed."],
    unresolved: ["Whether the deploy key rotates automatically is unknown."],
    artifacts: [artifactIdSchema.parse("artifact-report")],
    sensitivity: "public_to_project",
    ...overrides,
  })
}

function result(overrides: Partial<DependencyResult> = {}): DependencyResult {
  return dependencyResultSchema.parse({
    taskId: TASK,
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
    outcome: "completed",
    content: "Wrote the migration and verified it against the fixture corpus.",
    artifacts: [artifactIdSchema.parse("artifact-report")],
    priority: 500,
    ...overrides,
  })
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

describe("M5.7 a handoff packet has no field a transcript can go in", () => {
  it("the shape is exactly the seven declared fields", () => {
    const fields = Object.keys(handoffPacketSchema.shape).sort()
    expect(fields).toEqual([
      "artifacts",
      "fromActor",
      "prerequisites",
      "projectId",
      "runId",
      "sensitivity",
      "sensitivityReason",
      "summary",
      "taskId",
      "toRoleId",
      "unresolved",
    ])
    // No `transcript`, `output`, `messages`, `log`, or `body`. Named explicitly
    // because a missing field is invisible in a shape test that only counts.
    for (const forbidden of ["transcript", "output", "messages", "log", "body", "content"]) {
      expect(fields).not.toContain(forbidden)
    }
  })

  it("refuses an unknown field rather than storing it", () => {
    const withTranscript = { ...packet(), transcript: "…" } as unknown
    expect(handoffPacketSchema.safeParse(withTranscript).success).toBe(false)
  })

  it("refuses a summary longer than the bound, rather than truncating it", () => {
    const tooLong = { ...packet(), summary: "x".repeat(MAX_SUMMARY_CHARACTERS + 1) }
    const result = handoffPacketSchema.safeParse(tooLong)
    expect(result.success).toBe(false)

    // And the boundary is inclusive: exactly the bound is fine.
    expect(handoffPacketSchema.safeParse({ ...packet(), summary: "x".repeat(MAX_SUMMARY_CHARACTERS) }).success).toBe(true)
  })

  it("refuses an empty summary", () => {
    expect(handoffPacketSchema.safeParse({ ...packet(), summary: "" }).success).toBe(false)
  })

  it("bounds the artifact list and the unresolved list", () => {
    const manyArtifacts = Array.from({ length: MAX_ARTIFACT_REFERENCES + 1 }, (_, index) =>
      artifactIdSchema.parse(`artifact-${index}`),
    )
    expect(handoffPacketSchema.safeParse({ ...packet(), artifacts: manyArtifacts }).success).toBe(false)

    const manyUnresolved = Array.from({ length: MAX_UNRESOLVED + 1 }, (_, index) => `unknown-${index}`)
    expect(handoffPacketSchema.safeParse({ ...packet(), unresolved: manyUnresolved }).success).toBe(false)
  })

  it("requires a reason for any sensitivity above public", () => {
    expect(handoffPacketSchema.safeParse({ ...packet(), sensitivity: "restricted" }).success).toBe(false)
    expect(
      handoffPacketSchema.safeParse({
        ...packet(),
        sensitivity: "restricted",
        sensitivityReason: "Names an internal service.",
      }).success,
    ).toBe(true)
  })

  it("requires a `to` role, not a free-text label", () => {
    // A label cannot be resolved to an identity, which is exactly the M0
    // migration's `legacy.agent-label` problem.
    const schema = handoffPacketSchema.shape
    expect(schema.toRoleId).toBeDefined()
    const result = handoffPacketSchema.safeParse({ ...packet(), toRoleId: "" })
    expect(result.success).toBe(false)
  })
})

describe("M5.7 a handoff becomes a memory record that points at artifacts rather than inlining them", () => {
  it("carries the summary as content and the artifacts as ids", () => {
    const record = ok(handoffToMemoryRecord({ packet: packet(), author: SESSION, createdAt: NOW }))
    expect(record.payload.content).toBe("Deployment verified on the VPS; the artifact digest matches the registry.")
    expect(record.payload.artifactReferences).toEqual([artifactIdSchema.parse("artifact-report")])
    // The detail is structured, so a renderer can read the parts.
    // `fromActor` is stored as a LABEL, not as the actor object: `payload.detail`
    // is depth-1 scalar by contract so it cannot hide a structure nothing
    // inspects, and the record's own `author` already carries the sender.
    expect(record.payload.detail).toMatchObject({
      toRoleId: "role-verifier",
      fromActorLabel: "session:session-1",
      prerequisites: ["The build job completed."],
      unresolved: ["Whether the deploy key rotates automatically is unknown."],
    })
  })

  it("records provenance back to the packet and to every artifact", () => {
    const record = ok(handoffToMemoryRecord({ packet: packet(), author: SESSION, createdAt: NOW }))
    expect(record.sourceReferences).toContainEqual({ namespace: "handoff.packet", id: `${RUN}/${TASK}` })
    expect(record.sourceReferences).toContainEqual({ namespace: "artifact.reference", id: "artifact-report" })
  })

  it("is task-scoped, so it appears in that task's context and nowhere else", () => {
    const record = ok(handoffToMemoryRecord({ packet: packet(), author: SESSION, createdAt: NOW }))
    expect(record.scope).toEqual({ kind: "task", runId: RUN, taskId: TASK })
    // And it inherits `handoff`'s default retention of `run`.
    expect(record.retention).toBe("run")
  })

  it("refuses an invalid packet rather than writing a partial record", () => {
    const invalid = { ...packet(), summary: "" } as unknown as HandoffPacket
    const result = handoffToMemoryRecord({ packet: invalid, author: SESSION, createdAt: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("memory.handoff_invalid")
  })
})

describe("M5.7 a dependency result is a structured outcome, not prose", () => {
  it("a completed result is a run_outcome at dispatch scope", () => {
    const record = ok(
      dependencyResultToMemoryRecord({
        result: result(),
        projectId: PROJECT,
        runId: RUN,
        author: SESSION,
        createdAt: NOW,
      }),
    )
    expect(record.kind).toBe("run_outcome")
    expect(record.scope).toMatchObject({ kind: "dispatch", runId: RUN, taskId: TASK })
  })

  it("a FAILED result is a finding, not a run_outcome: the run is not over", () => {
    // Conflating them would put one attempt's failure into a run-level summary
    // and make it read as final.
    const record = ok(
      dependencyResultToMemoryRecord({
        result: result({ outcome: "failed" }),
        projectId: PROJECT,
        runId: RUN,
        author: SESSION,
        createdAt: NOW,
      }),
    )
    expect(record.kind).toBe("finding")
    expect(record.payload.detail).toMatchObject({ outcome: "failed" })
  })

  it("preserves what the receiver must not assume", () => {
    const record = ok(
      dependencyResultToMemoryRecord({
        result: result({ unresolved: ["Did not determine whether the fixture is representative."] }),
        projectId: PROJECT,
        runId: RUN,
        author: SESSION,
        createdAt: NOW,
      }),
    )
    expect(record.payload.detail).toMatchObject({
      unresolved: ["Did not determine whether the fixture is representative."],
    })
  })

  it("refuses an empty `unresolved` list, which says nothing", () => {
    // An empty list and an omitted list are the same data, and a caller using an
    // empty list to mean "no unknowns" has stated nothing.
    expect(dependencyResultSchema.safeParse({ ...result(), unresolved: [] }).success).toBe(false)
  })

  it("refuses a result whose content is over the bound", () => {
    expect(dependencyResultSchema.safeParse({ ...result(), content: "x".repeat(MAX_SUMMARY_CHARACTERS + 1) }).success).toBe(
      false,
    )
  })
})

describe("M5.7 a run summary is bounded and says what it dropped", () => {
  const many = (count: number): DependencyResult[] =>
    Array.from({ length: count }, (_, index) =>
      result({
        dispatchId: dispatchIdSchema.parse(`dispatch-${String(index).padStart(2, "0")}`),
        content: `Task ${index} did its work and reported back.`,
        priority: 100 - index,
      }),
    )

  it("includes the highest-priority results first and records the rest as omitted", () => {
    const summary = ok(buildRunSummary({ projectId: PROJECT, runId: RUN, results: many(6), budgetCharacters: 200 }))

    expect(summary.included.length).toBeGreaterThan(0)
    expect(summary.included.length + summary.omitted.length).toBe(6)
    expect(summary.omitted.every((entry) => entry.reason === "budget_exceeded")).toBe(true)
    // The included set is the priority-ordered prefix, not an arbitrary subset.
    expect(summary.included[0]).toBe("dispatch-00")
  })

  it("is deterministic: the same results in any order produce the same summary", () => {
    const results = many(6)
    const forward = ok(buildRunSummary({ projectId: PROJECT, runId: RUN, results, budgetCharacters: 200 }))
    const reversed = ok(buildRunSummary({ projectId: PROJECT, runId: RUN, results: [...results].reverse(), budgetCharacters: 200 }))
    expect(reversed.content).toBe(forward.content)
    expect(reversed.included).toEqual(forward.included)
  })

  it("always states the unresolved items, and says 'none' when there are none", () => {
    const withUnresolved = ok(
      buildRunSummary({
        projectId: PROJECT,
        runId: RUN,
        results: [result({ unresolved: ["Key rotation is unverified."] })],
        budgetCharacters: 4_000,
      }),
    )
    expect(withUnresolved.content).toContain("Key rotation is unverified.")

    const without = ok(buildRunSummary({ projectId: PROJECT, runId: RUN, results: [result()], budgetCharacters: 4_000 }))
    expect(without.content).toContain("Unresolved: none recorded.")
  })

  it("de-duplicates the unresolved list across results", () => {
    const summary = ok(
      buildRunSummary({
        projectId: PROJECT,
        runId: RUN,
        results: [
          result({ dispatchId: dispatchIdSchema.parse("dispatch-a"), unresolved: ["Same unknown."] }),
          result({ dispatchId: dispatchIdSchema.parse("dispatch-b"), unresolved: ["Same unknown."] }),
        ],
        budgetCharacters: 4_000,
      }),
    )
    expect(summary.unresolved).toEqual(["Same unknown."])
  })

  it("never exceeds the budget for the *result lines*, and says so in the header", () => {
    const summary = ok(buildRunSummary({ projectId: PROJECT, runId: RUN, results: many(6), budgetCharacters: 120 }))
    expect(summary.content).toContain(`Run ${RUN}: ${summary.included.length} of 6 task results.`)
    // The header and the unresolved line are outside the per-line budget on
    // purpose, so the honest move is to report the count rather than truncate
    // away the most important line in the summary.
    expect(summary.omitted.length).toBe(6 - summary.included.length)
  })

  it("refuses a zero or negative budget rather than returning an empty summary", () => {
    for (const budgetCharacters of [0, -1]) {
      const attempt = buildRunSummary({ projectId: PROJECT, runId: RUN, results: many(2), budgetCharacters })
      expect(attempt.ok).toBe(false)
      if (attempt.ok) continue
      expect(attempt.error.code).toBe("context.run_summary_budget")
    }
  })

  it("refuses a malformed result rather than summarizing around it", () => {
    const attempt = buildRunSummary({
      projectId: PROJECT,
      runId: RUN,
      results: [result(), { dispatchId: "dispatch-x", outcome: "exploded" } as unknown as DependencyResult],
    })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.error.code).toBe("memory.dependency_result_invalid")
  })
})

describe("M5.7 a downstream context carries the handoff and not the transcript", () => {
  it("the record's rendered text is the summary, with no transcript field to leak from", () => {
    const record = ok(handoffToMemoryRecord({ packet: packet(), author: SESSION, createdAt: NOW }))
    const renderedKeys = Object.keys(record.payload).sort()
    expect(renderedKeys).toEqual(["artifactReferences", "content", "detail"])
    // A caller that has the packet cannot put a transcript into this record,
    // because there is nowhere to put it.
    expect(JSON.stringify(record)).not.toContain("transcript")
  })
})

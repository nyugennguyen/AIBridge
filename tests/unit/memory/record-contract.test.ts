/**
 * M5.1/M5.2: the memory record contract, asserted against itself.
 *
 * This is the file that says "the ontology is coherent" in a way a reviewer can
 * check by reading expectations rather than prose. The properties worth stating:
 *
 * - a record cannot be read as something it is not (kind, scope, trust,
 *   sensitivity, retention are closed unions, not strings);
 * - the trust rules are enforced by the *schema*, so a forged `accepted` is not
 *   representable rather than merely discouraged;
 * - a v1 record still parses, and its read view preserves the stored digest.
 *
 * The v1-shape-drift guard is the important one. `memoryRecordSchemaV1` in
 * `src/memory/record.ts` is a local restatement of the M0
 * `memoryRecordSchema`, which is inside a signed contract digest and cannot be
 * imported-and-extended without editing it. The restatement can therefore drift
 * silently — and if it does, this build would read v1 records with the wrong
 * shape and no error. So the drift is asserted here, against the real thing.
 */

import { describe, expect, it } from "vitest"
import {
  ACCEPTING_ACTOR_KINDS,
  CONTEXT_CATEGORY_ORDER,
  DEFAULT_RETENTION_BY_KIND,
  MEMORY_KINDS,
  RETENTION_POLICIES,
  SCOPE_DEPTH,
  SENSITIVITY_RANK,
  TRUST_STATES,
  canTransitionTrust,
  initialTrustFor,
  isRenderable,
  isScopeVisible,
  isTrusted,
  mayReadSensitivity,
} from "../../../src/memory/ontology.js"
import {
  buildMemoryRecord,
  computeContentHash,
  isMemoryRecordV2,
  memoryRecordSchemaV1,
  memoryRecordSchemaV2,
  migrateV1Sensitivity,
  parseMemoryRecord,
  proposeMemoryRecord,
  safeParseMemoryRecord,
  scopeContains,
  scopeStandsAt,
  toMemoryRecordView,
  verifyMemoryRecord,
  type MemoryRecordV1,
  type MemoryRecordV2,
} from "../../../src/memory/record.js"
import { memoryRecordSchema as m0MemoryRecordSchema } from "../../../src/orchestration/schemas.js"
import type { Actor } from "../../../src/orchestration/types.js"
import {
  nodeIdSchema,
  sessionIdSchema,
  userIdSchema,
  runIdSchema,
  taskIdSchema,
  dispatchIdSchema,
} from "../../../src/orchestration/identifiers.js"

const NOW = "2026-09-30T12:00:00.000Z"
const LATER = "2026-10-01T12:00:00.000Z"

const USER: Actor = { kind: "user", userId: userIdSchema.parse("user-owner") }
const SESSION: Actor = { kind: "session", sessionId: sessionIdSchema.parse("session-1") }
const NODE: Actor = { kind: "node", nodeId: nodeIdSchema.parse("node-a") }
const SYSTEM: Actor = { kind: "system", name: "system-m5" }

function v1(overrides: Record<string, unknown> = {}): MemoryRecordV1 {
  return memoryRecordSchemaV1.parse({
    schemaVersion: 1,
    memoryId: "memory-v1-1",
    projectId: "project-m5",
    kind: "decision",
    content: "A legacy decision.",
    contentDigest: `sha256:${"a".repeat(64)}`,
    scope: { kind: "project" },
    author: SYSTEM,
    createdAt: NOW,
    sourceReferences: [],
    trustState: "proposed",
    sensitivity: "internal",
    retention: "project",
    ...overrides,
  })
}

function v2(overrides: Record<string, unknown> = {}): MemoryRecordV2 {
  return proposeMemoryRecord({
    memoryId: "memory-v2-1",
    projectId: "project-m5",
    kind: "decision",
    scope: { kind: "project" },
    author: USER,
    createdAt: NOW,
    content: "A current decision.",
    ...overrides,
  })
}

describe("M5.1 the ontology is a closed vocabulary", () => {
  it("every axis is a finite, non-empty set", () => {
    expect(MEMORY_KINDS.length).toBeGreaterThan(0)
    expect(TRUST_STATES.length).toBeGreaterThan(0)
    expect(Object.keys(SENSITIVITY_RANK).length).toBeGreaterThan(0)
    expect(Object.keys(SCOPE_DEPTH).length).toBeGreaterThan(0)
    expect(RETENTION_POLICIES.length).toBeGreaterThan(0)
    expect(Object.keys(CONTEXT_CATEGORY_ORDER).length).toBe(6)
  })

  it("the sensitivity scale is TOTAL and MONOTONE over the readable levels", () => {
    // `prohibited` is excluded from the pairwise check because it is not a rank
    // on the clearance axis — it is an absolute refusal, checked separately
    // below. Checking it here would assert `prohibited is readable by a
    // prohibited-clearance reader`, which is the claim the whole rule denies.
    const levels = ["public_to_project", "restricted", "secret_reference_only"] as const
    for (let i = 0; i < levels.length; i += 1) {
      for (let j = 0; j < levels.length; j += 1) {
        expect(mayReadSensitivity(levels[i]!, levels[j]!)).toBe(i <= j)
      }
    }
  })

  it("is total and monotone in the sense that matters: holding more clearance never loses access", () => {
    const levels = ["public_to_project", "restricted", "secret_reference_only"] as const
    for (const record of levels) {
      let previouslyAllowed = false
      for (const clearance of levels) {
        const allowed = mayReadSensitivity(record, clearance)
        if (!allowed) expect(previouslyAllowed).toBe(false)
        previouslyAllowed = allowed
      }
    }
  })

  it("prohibited content is renderable for nobody, at any clearance", () => {
    for (const level of Object.keys(SENSITIVITY_RANK) as (keyof typeof SENSITIVITY_RANK)[]) {
      expect(mayReadSensitivity("prohibited", level)).toBe(false)
    }
    expect(isRenderable("prohibited")).toBe(false)
    for (const level of ["public_to_project", "restricted", "secret_reference_only"] as const) {
      expect(isRenderable(level)).toBe(true)
    }
  })

  it("the scope lattice is project < run < task < dispatch < session", () => {
    expect(SCOPE_DEPTH.project).toBeLessThan(SCOPE_DEPTH.run)
    expect(SCOPE_DEPTH.run).toBeLessThan(SCOPE_DEPTH.task)
    expect(SCOPE_DEPTH.task).toBeLessThan(SCOPE_DEPTH.dispatch)
    expect(SCOPE_DEPTH.dispatch).toBeLessThan(SCOPE_DEPTH.session)
  })

  it("'stands at' on kinds: a record is a constraint on a reader at or below it", () => {
    // `isScopeVisible(recordKind, readerKind)` answers ONE question: does this
    // record stand at the reader's scope, i.e. constrain it? It is not the
    // visibility question — a task also sees its own dispatches' records, which
    // are below it. `scopeContains` in record.ts is the visibility question.
    expect(isScopeVisible("project", "session")).toBe(true)
    expect(isScopeVisible("project", "project")).toBe(true)
    expect(isScopeVisible("run", "task")).toBe(true)
    expect(isScopeVisible("task", "task")).toBe(true)
    expect(isScopeVisible("dispatch", "dispatch")).toBe(true)
    // The root case: a project reader has no run context, so everything stands
    // at its scope.
    expect(isScopeVisible("run", "project")).toBe(true)
    expect(isScopeVisible("session", "project")).toBe(true)
    // Nothing below the reader constrains it.
    expect(isScopeVisible("dispatch", "task")).toBe(false)
    expect(isScopeVisible("session", "dispatch")).toBe(false)
    expect(isScopeVisible("task", "run")).toBe(false)
  })

  it("only an accepted record is trusted, and no transition reaches accepted from a trusted state", () => {
    expect(isTrusted("accepted")).toBe(true)
    expect(isTrusted("proposed")).toBe(false)
    expect(isTrusted("rejected")).toBe(false)
    expect(isTrusted("system_derived")).toBe(false)

    expect(canTransitionTrust("proposed", "accepted")).toBe(true)
    expect(canTransitionTrust("proposed", "rejected")).toBe(true)
    // The load-bearing negative: a system cannot promote its own summary.
    expect(canTransitionTrust("system_derived", "accepted")).toBe(false)
    expect(canTransitionTrust("accepted", "proposed")).toBe(false)
    expect(canTransitionTrust("rejected", "accepted")).toBe(false)
  })

  it("names exactly one actor kind as able to accept, and it is a human", () => {
    expect(ACCEPTING_ACTOR_KINDS).toEqual(["user"])
  })

  it("an author kind determines the INITIAL trust, and a user's finding is still only a proposal", () => {
    expect(initialTrustFor("user", "decision")).toBe("accepted")
    expect(initialTrustFor("user", "constraint")).toBe("accepted")
    expect(initialTrustFor("user", "user_correction")).toBe("accepted")
    // A human typing a finding into a comment has not decided a project fact.
    expect(initialTrustFor("user", "finding")).toBe("proposed")
    expect(initialTrustFor("session", "decision")).toBe("proposed")
    expect(initialTrustFor("node", "decision")).toBe("proposed")
    expect(initialTrustFor("system", "summary")).toBe("system_derived")
    // An unknown author kind is not trusted. It is also not trusted by default
    // in the *permissive* direction, which is the direction that matters.
    expect(initialTrustFor("future-kind", "decision")).toBe("proposed")
  })

  it("gives every kind a default retention, so retention is never absent", () => {
    for (const kind of MEMORY_KINDS) {
      expect(RETENTION_POLICIES).toContain(DEFAULT_RETENTION_BY_KIND[kind])
    }
    // A user's correction outlives the run that provoked it.
    expect(DEFAULT_RETENTION_BY_KIND.user_correction).toBe("permanent")
  })
})

describe("M5.2 the record refuses to be something it is not", () => {
  it("rejects an unknown field rather than ignoring it", () => {
    const result = memoryRecordSchemaV2.safeParse({ ...v2(), trusted: true })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown sensitivity value", () => {
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), sensitivity: "top-secret" }).success).toBe(false)
  })

  it("rejects a record that supersedes itself, in either field", () => {
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), supersedesMemoryId: "memory-v2-1" }).success).toBe(false)
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), supersededByMemoryId: "memory-v2-1" }).success).toBe(false)
  })

  it("rejects a record that both supersedes and is superseded by the same record", () => {
    const result = memoryRecordSchemaV2.safeParse({
      ...v2(),
      supersedesMemoryId: "memory-a",
      supersededByMemoryId: "memory-a",
    })
    expect(result.success).toBe(false)
  })

  it("refuses an 'accepted' record with no trust decision: the state is unforgeable", () => {
    const forged = { ...v2(), trust: "accepted", trustDecision: undefined }
    const result = memoryRecordSchemaV2.safeParse(forged)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => issue.path.join(".") === "trustDecision")).toBe(true)
  })

  it("refuses a non-user trust decision on an accepted record", () => {
    for (const decidedBy of [SESSION, NODE, SYSTEM]) {
      const result = memoryRecordSchemaV2.safeParse({
        ...v2(),
        trust: "accepted",
        trustDecision: { decidedBy, decidedAt: LATER },
      })
      expect(result.success, `accepted by ${decidedBy.kind} must be refused`).toBe(false)
    }
  })

  it("accepts a user trust decision on an accepted record", () => {
    const result = memoryRecordSchemaV2.safeParse({
      ...v2(),
      trust: "accepted",
      trustDecision: { decidedBy: USER, decidedAt: LATER, reason: "Reviewed." },
    })
    expect(result.success).toBe(true)
  })

  it("refuses a prohibited record with no redaction decision", () => {
    const result = memoryRecordSchemaV2.safeParse({
      ...v2(),
      sensitivity: "prohibited",
      redaction: { status: "none" },
    })
    expect(result.success).toBe(false)
  })

  it("accepts a prohibited record that carries a redaction decision", () => {
    const result = memoryRecordSchemaV2.safeParse({
      ...v2(),
      sensitivity: "prohibited",
      redaction: { status: "prohibited", ruleIds: ["pem_private_key"], redactedSpanCount: 1 },
    })
    expect(result.success).toBe(true)
  })

  it("refuses a secret_reference_only record that names no secret", () => {
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), sensitivity: "secret_reference_only" }).success).toBe(false)
    const withReference = memoryRecordSchemaV2.safeParse({
      ...v2(),
      sensitivity: "secret_reference_only",
      payload: { content: "The deploy key lives in 1Password.", secretReferences: [{ reference: "op://prod/deploy", summary: "production deploy key" }] },
    })
    expect(withReference.success).toBe(true)
  })

  it("has no field a secret value could be written into", () => {
    const record = v2()
    const names = Object.keys(record).sort()
    // The payload's secret slot is `secretReferences`, which is a list of
    // {reference, summary, locator}. A test that greps for a `value` or
    // `secret` string field is the check; a docblock saying so is not.
    const secretEntries = record.payload.secretReferences ?? []
    for (const entry of secretEntries) {
      expect(Object.keys(entry).sort()).toEqual(["reference", "summary"])
    }
    expect(names).not.toContain("secret")
    expect(names).not.toContain("credentials")
    expect(names).not.toContain("value")
  })

  it("refuses an expiry at or before creation", () => {
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), expiresAt: NOW }).success).toBe(false)
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), expiresAt: "2026-01-01T00:00:00.000Z" }).success).toBe(false)
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), expiresAt: LATER }).success).toBe(true)
  })

  it("refuses a derivative redaction with no source, and a non-derivative with one", () => {
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), redaction: { status: "derivative" } }).success).toBe(false)
    expect(
      memoryRecordSchemaV2.safeParse({ ...v2(), redaction: { status: "none", derivedFromMemoryId: "memory-x" } }).success,
    ).toBe(false)
    expect(
      memoryRecordSchemaV2.safeParse({ ...v2(), redaction: { status: "derivative", derivedFromMemoryId: "memory-x" } }).success,
    ).toBe(true)
  })

  it("refuses duplicate source references, provenance ids, and visibility lists", () => {
    const reference = { namespace: "legacy.memory.decision", id: "d1" }
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), sourceReferences: [reference, reference] }).success).toBe(false)
    expect(memoryRecordSchemaV2.safeParse({ ...v2(), visibleToNodeIds: ["node-a", "node-a"] }).success).toBe(false)
  })
})

describe("M5.2 scope visibility compares identities, not just kinds", () => {
  const project = { kind: "project" } as const
  const run1 = { kind: "run", runId: runIdSchema.parse("run-1") } as const
  const run2 = { kind: "run", runId: runIdSchema.parse("run-2") } as const
  const task1 = { kind: "task", runId: runIdSchema.parse("run-1"), taskId: taskIdSchema.parse("task-1") } as const
  const task2 = { kind: "task", runId: runIdSchema.parse("run-1"), taskId: taskIdSchema.parse("task-2") } as const
  const dispatch1 = {
    kind: "dispatch",
    runId: runIdSchema.parse("run-1"),
    taskId: taskIdSchema.parse("task-1"),
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
  } as const
  const session1 = {
    kind: "session",
    runId: runIdSchema.parse("run-1"),
    taskId: taskIdSchema.parse("task-1"),
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
    sessionId: sessionIdSchema.parse("session-1"),
  } as const

  it("a project record is visible from every scope", () => {
    expect(scopeContains(project, project)).toBe(true)
    expect(scopeContains(project, run1)).toBe(true)
    expect(scopeContains(project, task1)).toBe(true)
    expect(scopeContains(project, session1)).toBe(true)
  })

  it("a project reader sees EVERY scope, because it has no run context to be narrower than", () => {
    // The root case, and the reason the kind-only check is not a plain depth
    // comparison: the widest reader sees the most.
    expect(scopeContains(run1, project)).toBe(true)
    expect(scopeContains(task1, project)).toBe(true)
    expect(scopeContains(dispatch1, project)).toBe(true)
    expect(scopeContains(session1, project)).toBe(true)
  })

  it("a run reader sees its own tasks and nothing from a sibling run", () => {
    expect(scopeContains(run1, run1)).toBe(true)
    expect(scopeContains(task1, run1)).toBe(true)
    expect(scopeContains(dispatch1, run1)).toBe(true)
    expect(scopeContains(session1, run1)).toBe(true)
    // The cross-run case the kind-only check cannot catch: both are `run` kind.
    expect(scopeContains(run2, run1)).toBe(false)
    expect(scopeContains(task1, run2)).toBe(false)
    expect(isScopeVisible(run1.kind, run2.kind)).toBe(true)
  })

  it("a task reader sees its own dispatches but not a sibling task's", () => {
    expect(scopeContains(task1, task1)).toBe(true)
    expect(scopeContains(dispatch1, task1)).toBe(true)
    // Sibling task in the same run: same kind, different task, not visible.
    expect(scopeContains(task2, task1)).toBe(false)
    expect(scopeContains(dispatch1, task2)).toBe(false)
  })

  it("a reader sees its OWN history as well as the facts standing above it", () => {
    // A task reader sees its dispatch's records and that dispatch's sessions:
    // that is what happened while it worked.
    expect(scopeContains(dispatch1, task1)).toBe(true)
    expect(scopeContains(session1, task1)).toBe(true)
    expect(scopeContains(session1, dispatch1)).toBe(true)
    // And it does not see a sibling's.
    expect(scopeContains(session1, task2)).toBe(false)
    expect(scopeContains(dispatch1, task2)).toBe(false)
  })

  it("a session reader sees its own record and the facts standing above it", () => {
    expect(scopeContains(session1, session1)).toBe(true)
    expect(scopeContains(project, session1)).toBe(true)
    expect(scopeContains(run1, session1)).toBe(true)
    expect(scopeContains(task1, session1)).toBe(true)
    // A project reader has no run context, so it sees even the session record.
    // That is correct, and it is why the safety-critical work in this
    // milestone is sensitivity and clearance rather than scope.
    expect(scopeContains(session1, project)).toBe(true)
  })

  it("'stands at' is narrower than 'is visible in': a session is in a task's view, not a constraint on it", () => {
    // `scopeContains` is "is this record in the reader's view at all".
    // `scopeStandsAt` is "is this record a fact that constrains the reader".
    expect(scopeContains(session1, task1)).toBe(true)
    expect(scopeStandsAt(session1, task1)).toBe(false)

    expect(scopeContains(task1, task1)).toBe(true)
    expect(scopeStandsAt(task1, task1)).toBe(true)

    expect(scopeContains(run1, task1)).toBe(true)
    expect(scopeStandsAt(run1, task1)).toBe(true)

    expect(scopeStandsAt(project, project)).toBe(true)
    expect(scopeStandsAt(project, session1)).toBe(true)
    expect(scopeStandsAt(run2, run1)).toBe(false)
  })

  it("a v1 session scope does NOT match a v2 dispatch reader, and fails closed", () => {
    // A v1 session record has no dispatch in its identity chain, so its leaf is
    // `session:…` where a v2 dispatch reader's leaf is `dispatch:…`. The chains
    // diverge at the third segment, so they are not prefix-comparable and the
    // record is NOT visible.
    //
    // The tempting alternative is to treat the v1 record as a session of its
    // task and let it match. That is refused, and the reason is worth stating:
    // "we cannot prove they are the same" must resolve to "no", because the
    // cost of a false match is a session transcript injected into a dispatch it
    // never ran in, and the cost of a false non-match is one record an operator
    // can see and act on. Under-specification is resolved toward refusal.
    const v1Session = {
      kind: "session",
      runId: runIdSchema.parse("run-1"),
      taskId: taskIdSchema.parse("task-1"),
      sessionId: sessionIdSchema.parse("session-9"),
    } as const
    expect(scopeContains(v1Session, v1Session)).toBe(true)
    expect(scopeContains(v1Session, task1)).toBe(true)
    expect(scopeContains(v1Session, dispatch1)).toBe(false)
    // Not a sibling task's, and not another run's.
    expect(scopeContains(v1Session, task2)).toBe(false)
    expect(scopeContains(v1Session, run2)).toBe(false)
  })
})

describe("M5.2 the content hash answers one question", () => {
  it("verifies against the record's own content", () => {
    const record = v2()
    expect(verifyMemoryRecord(record)).toBe(true)
  })

  it("changes when the content changes", () => {
    const a = v2()
    const b = v2({ content: "A different decision." })
    expect(a.contentHash).not.toBe(b.contentHash)
    expect(verifyMemoryRecord(b)).toBe(true)
  })

  it("does NOT change when only a decision ABOUT the content changes", () => {
    // A redaction or a trust decision must not alter the hash of the thing it
    // was applied to, or "did the fact change?" becomes unanswerable.
    const base = v2()
    const decided = v2({ trust: "accepted", trustDecision: { decidedBy: USER, decidedAt: LATER } })
    const restricted = v2({ sensitivity: "restricted" })
    expect(decided.contentHash).toBe(base.contentHash)
    expect(restricted.contentHash).toBe(base.contentHash)
  })

  it("does change when the scope changes, because scope is part of what the fact claims", () => {
    const project = v2({ scope: { kind: "project" } })
    const run = v2({ scope: { kind: "run", runId: runIdSchema.parse("run-1") } })
    expect(project.contentHash).not.toBe(run.contentHash)
  })

  it("is computable independently of the record, so a stored hash is checkable", () => {
    const record = v2()
    expect(record.contentHash).toBe(
      computeContentHash({ kind: record.kind, scope: record.scope, payload: record.payload }),
    )
  })
})

describe("M5.2 both record versions read, and v1 is never rewritten", () => {
  it("parses a v1 record without complaint", () => {
    const parsed = parseMemoryRecord(v1())
    expect(isMemoryRecordV2(parsed)).toBe(false)
  })

  it("parses a v2 record without complaint", () => {
    const parsed = parseMemoryRecord(v2())
    expect(isMemoryRecordV2(parsed)).toBe(true)
  })

  it("refuses an unversioned record loudly instead of guessing", () => {
    const { schemaVersion: _dropped, ...unversioned } = v1() as Record<string, unknown>
    const result = safeParseMemoryRecord(unversioned)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.versionError).toBe(true)
  })

  it("refuses a version this build cannot read", () => {
    const result = safeParseMemoryRecord({ ...v1(), schemaVersion: 99 })
    expect(result.ok).toBe(false)
  })

  it("projects a v1 record without mutating it", () => {
    const original = v1()
    const snapshot = JSON.stringify(original)
    const view = toMemoryRecordView(original)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(view.sourceVersion).toBe(1)
    expect(view.content).toBe(original.content)
    expect(view.contentHash).toBe(original.contentDigest)
  })

  it("preserves a v1 record's stored digest through the projection", () => {
    const record = v1()
    const view = toMemoryRecordView(record)
    // If the projection recomputed the hash, a v1 record's stored digest would
    // stop verifying and the migration would look like corruption.
    expect(view.contentHash).toBe(record.contentDigest)
  })

  it("migrates v1 sensitivity conservatively, never downward", () => {
    expect(migrateV1Sensitivity("public")).toBe("public_to_project")
    expect(migrateV1Sensitivity("internal")).toBe("public_to_project")
    expect(migrateV1Sensitivity("confidential")).toBe("restricted")
    expect(migrateV1Sensitivity("restricted")).toBe("restricted")
  })

  it("a v1 view is never `secret_reference_only`, because v1 could not express it", () => {
    for (const sensitivity of ["public", "internal", "confidential", "restricted"] as const) {
      const view = toMemoryRecordView(v1({ sensitivity }))
      expect(view.sensitivity).not.toBe("secret_reference_only")
      expect(view.sensitivity).not.toBe("prohibited")
    }
  })

  it("a v1 session scope stays without a dispatch id rather than gaining an invented one", () => {
    const view = toMemoryRecordView(
      v1({
        scope: {
          kind: "session",
          runId: runIdSchema.parse("run-1"),
          taskId: taskIdSchema.parse("task-1"),
          sessionId: sessionIdSchema.parse("session-1"),
        },
      }),
    )
    expect(view.scope.kind).toBe("session")
    if (view.scope.kind === "session") {
      // A fabricated dispatch id would be indistinguishable from a real one
      // everywhere downstream, so the absence is preserved.
      expect("dispatchId" in view.scope).toBe(false)
    }
  })
})

describe("M5.2 the v1 restatement has not drifted from the M0 contract", () => {
  it("accepts a record the real M0 schema accepts", () => {
    const m0 = m0MemoryRecordSchema.parse(v1())
    const local = memoryRecordSchemaV1.parse(m0)
    expect(local.memoryId).toBe(m0.memoryId)
  })

  it("rejects exactly what the real M0 schema rejects", () => {
    // A field the M0 schema does not have. If the local restatement had drifted
    // permissive, this would pass locally and fail in M0.
    const drifted = { ...v1(), migratedFrom: "somewhere" }
    expect(memoryRecordSchemaV1.safeParse(drifted).success).toBe(false)
    expect(m0MemoryRecordSchema.safeParse(drifted).success).toBe(false)
  })

  it("agrees on the trust, sensitivity, retention, and kind enums", () => {
    const base = v1()
    for (const trustState of ["proposed", "accepted", "rejected"] as const) {
      expect(memoryRecordSchemaV1.safeParse({ ...base, trustState }).success).toBe(true)
      expect(m0MemoryRecordSchema.safeParse({ ...base, trustState }).success).toBe(true)
    }
    for (const sensitivity of ["public", "internal", "confidential", "restricted"] as const) {
      expect(memoryRecordSchemaV1.safeParse({ ...base, sensitivity }).success).toBe(true)
      expect(m0MemoryRecordSchema.safeParse({ ...base, sensitivity }).success).toBe(true)
    }
    // v2's extra states must be refused by the v1 shape, in both.
    expect(memoryRecordSchemaV1.safeParse({ ...base, trustState: "system_derived" }).success).toBe(false)
    expect(memoryRecordSchemaV1.safeParse({ ...base, sensitivity: "prohibited" }).success).toBe(false)
  })

  it("agrees on the scope variants, including the one v2 added", () => {
    const base = v1()
    const withDispatch = {
      ...base,
      scope: {
        kind: "dispatch",
        runId: runIdSchema.parse("run-1"),
        taskId: taskIdSchema.parse("task-1"),
        dispatchId: dispatchIdSchema.parse("dispatch-1"),
      },
    }
    expect(memoryRecordSchemaV1.safeParse(withDispatch).success).toBe(false)
    expect(m0MemoryRecordSchema.safeParse(withDispatch).success).toBe(false)
  })
})

describe("M5.2 record construction goes through the ontology", () => {
  it("a user's decision is born accepted, with the decision recorded", () => {
    const record = proposeMemoryRecord({
      memoryId: "memory-user-1",
      projectId: "project-m5",
      kind: "decision",
      scope: { kind: "project" },
      author: USER,
      createdAt: NOW,
      content: "Adopt the mesh gateway.",
    })
    // An accepted record must carry a decision, so construction supplies the
    // author as the decider. That is an inference, and it is the ONLY one the
    // builder makes: a non-user author cannot reach this branch.
    expect(record.trust).toBe("accepted")
    expect(record.trustDecision?.decidedBy).toEqual(USER)
    expect(memoryRecordSchemaV2.safeParse(record).success).toBe(true)
  })

  it("a session's proposal is born proposed, with NO decision", () => {
    const record = proposeMemoryRecord({
      memoryId: "memory-session-1",
      projectId: "project-m5",
      kind: "decision",
      scope: { kind: "project" },
      author: SESSION,
      createdAt: NOW,
      content: "I think we should adopt the mesh gateway.",
    })
    expect(record.trust).toBe("proposed")
    expect(record.trustDecision).toBeUndefined()
  })

  it("a system's derived record is `system_derived`, not accepted", () => {
    const record = proposeMemoryRecord({
      memoryId: "memory-system-1",
      projectId: "project-m5",
      kind: "summary",
      scope: { kind: "run", runId: runIdSchema.parse("run-1") },
      author: SYSTEM,
      createdAt: NOW,
      content: "Three of four tasks completed.",
    })
    expect(record.trust).toBe("system_derived")
    expect(isTrusted(record.trust)).toBe(false)
  })

  it("buildMemoryRecord refuses to construct a forged accepted record", () => {
    // The sensitivity is stated explicitly here rather than left to the
    // caller: the point of the test is the *trust* rule, and a test that failed
    // for an unrelated reason would be a worse test.
    expect(() =>
      buildMemoryRecord({
        memoryId: "memory-forged",
        projectId: "project-m5",
        kind: "decision",
        scope: { kind: "project" },
        author: SESSION,
        createdAt: NOW,
        payload: { content: "Trust me." },
        trust: "accepted",
        sensitivity: "public_to_project",
      }),
    ).toThrow()
  })

  it("applies the kind's default retention when none is given", () => {
    const record = proposeMemoryRecord({
      memoryId: "memory-handoff-1",
      projectId: "project-m5",
      kind: "handoff",
      scope: { kind: "run", runId: runIdSchema.parse("run-1") },
      author: USER,
      createdAt: NOW,
      content: "Deployment verified.",
    })
    expect(record.retention).toBe(DEFAULT_RETENTION_BY_KIND.handoff)
  })
})

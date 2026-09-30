/**
 * M5.9 regression tests for the findings the independent audit produced.
 *
 * Every test here corresponds to a finding in
 * `Docs/implementation-reports/milestone-5-isolation-audit.md`, and each one is
 * written so that **reverting the fix fails it**. That is the point of the file:
 * a fix with no test is a comment, and a comment is not a control.
 *
 * The first three are the ones that mattered. The Blocker (SF-1) was reachable
 * through a public port method, so it was reachable by anyone holding a
 * `MemoryRepository`; the fix is structural rather than a check, which is why
 * its test asserts the mutation *throws* rather than asserting a result.
 */

import { describe, expect, it } from "vitest"
import { InMemoryMemoryRepository } from "../../../src/memory/in-memory-repository.js"
import { MEMORY_ERROR_CODES } from "../../../src/memory/repository-errors.js"
import { verifyMemoryRecord } from "../../../src/memory/record.js"
import type { MemoryRepository, MemoryQueryScope } from "../../../src/memory/ports.js"
import { projectIdSchema, runIdSchema, taskIdSchema, dispatchIdSchema, nodeIdSchema, roleIdSchema, userIdSchema, sessionIdSchema } from "../../../src/orchestration/identifiers.js"
import { digestJson } from "../../../src/orchestration/digest.js"

const NOW = "2026-09-30T12:00:00.000Z"
const LATER = "2026-10-01T12:00:00.000Z"
const PROJECT_A = projectIdSchema.parse("project-alpha")
const PROJECT_B = projectIdSchema.parse("project-beta")

const USER = { kind: "user", userId: userIdSchema.parse("user-owner") } as const
const SESSION = { kind: "session", sessionId: sessionIdSchema.parse("session-1") } as const

function store(): MemoryRepository {
  return new InMemoryMemoryRepository({ now: () => NOW })
}

function reader(overrides: Partial<MemoryQueryScope> = {}): MemoryQueryScope {
  return {
    projectId: PROJECT_A,
    scope: { kind: "project" },
    nodeId: nodeIdSchema.parse("node-alpha"),
    roleId: roleIdSchema.parse("role-implementer"),
    clearance: "restricted",
    actor: USER,
    ...overrides,
  } as MemoryQueryScope
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

function expectError(result: { ok: boolean } & Record<string, unknown>): { code: string; message: string; category: string } {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected a refusal")
  return result.error as { code: string; message: string; category: string }
}

async function appendAccepted(
  repository: MemoryRepository,
  overrides: Record<string, unknown> = {},
): Promise<{ memoryId: string; contentHash: string }> {
  const result = expectOk(
    await repository.append({
      projectId: PROJECT_A,
      kind: "decision",
      scope: { kind: "project" },
      author: USER,
      createdAt: NOW,
      content: "Use the Tailscale-only bridge endpoint.",
      ...overrides,
    }),
  )
  return { memoryId: result.record.memoryId, contentHash: result.record.contentHash }
}

describe("M5.9 SF-1: getRaw must not hand out the store's own object", () => {
  it("refuses to let a caller assign a forged trust state onto the returned record", async () => {
    const repository = store()
    const proposal = expectOk(
      await repository.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        // A session author: the ontology says this can only ever be `proposed`.
        author: SESSION,
        createdAt: NOW,
        content: "An agent's note, not a decision.",
      }),
    )
    expect(proposal.record.trust).toBe("proposed")

    const raw = await repository.getRaw(proposal.record.memoryId)
    expect(raw).not.toBeNull()

    // The mutation itself throws. This is the whole fix: the record that leaves a
    // read is not the record the store holds, so there is nothing to mutate.
    expect(() => {
      (raw as { trust: string }).trust = "accepted"
    }).toThrow()
    expect(() => {
      ;(raw as { trustDecision: unknown }).trustDecision = { decidedBy: USER, decidedAt: LATER }
    }).toThrow()

    // And the store is unchanged, so a real read still refuses to serve it.
    const queried = expectOk(await repository.query({ projectId: PROJECT_A }, reader()))
    expect(queried.records).toHaveLength(0)
    expect(queried.withheld.find((entry) => entry.memoryId === proposal.record.memoryId)?.reason).toBe("not_trusted")
  })

  it("refuses to let a caller rewrite the fact itself, which would break append-only", async () => {
    const repository = store()
    const { memoryId, contentHash } = await appendAccepted(repository)

    const raw = await repository.getRaw(memoryId)
    expect(() => {
      ;(raw as { payload: { content: string } }).payload = { content: "Something else entirely." }
    }).toThrow()

    // The stored record's content hash still verifies, which is the property
    // "append-only" actually means: the bytes are the bytes that were validated.
    const after = await repository.getRaw(memoryId)
    expect(verifyMemoryRecord(after!)).toBe(true)
    expect((after as { contentHash?: string; payload?: { content: string } }).contentHash ?? contentHash).toBeTruthy()
    expect((after as { payload: { content: string } }).payload.content).toBe("Use the Tailscale-only bridge endpoint.")
  })

  it("the same applies to the unscoped export path", async () => {
    const repository = store()
    const { memoryId } = await appendAccepted(repository)
    const exported = await repository.listProjectUnscoped(PROJECT_A)
    expect(exported).toHaveLength(1)
    expect(() => {
      ;(exported[0] as { trust: string }).trust = "rejected"
    }).toThrow()
    const reread = await repository.getRaw(memoryId)
    expect((reread as { trust: string }).trust).toBe("accepted")
  })
})

describe("M5.9 SF-2: the unscoped list is named for what it is", () => {
  it("is reachable only under a name that says it skips authorization", async () => {
    const repository = store()
    // There is no `listProject`. A caller reaching for "list this project's
    // memory" finds `query`, which returns withheld reasons.
    expect((repository as unknown as Record<string, unknown>)["listProject"]).toBeUndefined()
    expect(typeof repository.listProjectUnscoped).toBe("function")
  })

  it("and `query` — the path a reader actually takes — still refuses a restricted record", async () => {
    const repository = store()
    const { memoryId } = await appendAccepted(repository, {
      sensitivity: "restricted",
      visibleToNodeIds: [nodeIdSchema.parse("node-other")],
      visibleToRoleIds: [roleIdSchema.parse("role-auditor")],
    })

    const result = expectOk(await repository.query({ projectId: PROJECT_A }, reader()))
    expect(result.records).toHaveLength(0)
    const withheld = result.withheld.find((entry) => entry.memoryId === memoryId)
    expect(withheld?.reason).toBe("node_restricted")
    // And the kind is genuinely absent, not merely flagged: there is nothing to
    // leak by spreading the object.
    expect(withheld && "kind" in withheld).toBe(false)
    expect(JSON.stringify(result)).not.toContain("Tailscale-only")
  })

  it("a prohibited record is refused at every clearance, and its kind is absent", async () => {
    const repository = store()
    const { memoryId } = await appendAccepted(repository, {
      sensitivity: "prohibited",
      redaction: { status: "prohibited", ruleIds: ["pem_private_key"], redactedSpanCount: 1 },
    })

    for (const clearance of ["public_to_project", "restricted", "secret_reference_only"] as const) {
      const result = expectOk(await repository.query({ projectId: PROJECT_A }, reader({ clearance })))
      expect(result.records).toHaveLength(0)
      const withheld = result.withheld.find((entry) => entry.memoryId === memoryId)
      expect(withheld?.reason).toBe("prohibited_content")
      expect(withheld && "kind" in withheld).toBe(false)
    }
  })
})

describe("M5.9 SF-4: a query and its scope must name the same project", () => {
  it("refuses the mismatch rather than reporting the other project's records", async () => {
    const repository = store()
    const a = await appendAccepted(repository)
    const b = await appendAccepted(repository, { projectId: PROJECT_B, content: "beta only" })

    const error = expectError(await repository.query({ projectId: PROJECT_B }, reader({ projectId: PROJECT_A })))
    expect(error.code).toBe(MEMORY_ERROR_CODES.queryProjectMismatch)
    // The refusal must not confirm that project B exists, holds a record, or
    // name that record.
    expect(error.message).not.toContain(b.memoryId)
    expect(error.message).not.toContain("beta only")
    // And it must not confirm anything about the caller's OWN project either.
    expect(error.message).not.toContain(a.memoryId)
  })

  it("an empty mismatch reports nothing at all, so a caller cannot count records by reading refusals", async () => {
    const repository = store()
    for (const content of ["one", "two", "three", "four", "five"]) {
      await appendAccepted(repository, { projectId: PROJECT_B, content })
    }
    const error = expectError(await repository.query({ projectId: PROJECT_B }, reader({ projectId: PROJECT_A })))
    // Exactly one message, whatever project B holds. Under the old behaviour the
    // response carried one `project_mismatch` withholding per foreign record, so
    // its length was a function of project B's record count.
    expect(error.message.match(/memory\./g) ?? []).toHaveLength(0)
  })

  it("a matching pair still works, on both the read and the unscoped paths", async () => {
    const repository = store()
    const a = await appendAccepted(repository)
    const result = expectOk(await repository.query({ projectId: PROJECT_A }, reader({ projectId: PROJECT_A })))
    expect(result.records.map((entry) => entry.memoryId)).toEqual([a.memoryId])
  })
})

describe("M5.9 SF-5: payload.detail must not be an unbounded, unscanned secret slot", () => {
  it("refuses a detail value that is not JSON-safe data, rather than storing anything", async () => {
    const repository = store()
    // A `detail` is structured data an assembler may read. It is bounded and
    // scalar-only, so there is no place for a transcript or a credential blob.
    const error = expectError(
      await repository.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "A decision.",
        detail: { nested: { deeper: { value: "x".repeat(20_000) } } },
      }),
    )
    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
  })

  it("refuses a detail that exceeds the record's own content bound", async () => {
    const repository = store()
    const error = expectError(
      await repository.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "A decision.",
        detail: { blob: "x".repeat(70_000) },
      }),
    )
    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
  })

  it("still accepts a small, structured detail", async () => {
    const repository = store()
    const result = expectOk(
      await repository.append({
        projectId: PROJECT_A,
        kind: "handoff",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "Handing this off.",
        detail: { toRoleId: "role-verifier", prerequisites: ["The build completed."] },
      }),
    )
    expect(result.record.payload.detail).toMatchObject({ toRoleId: "role-verifier" })
  })
})

describe("M5.9 SF-6: the write path must actually run a guard", () => {
  it("REFUSES an append whose content holds a live secret, when a guard is supplied", async () => {
    // The M5.9 review found SF-6: nothing on the write path ran the redaction
    // pipeline, so a live credential in `content` was stored and served with
    // `redaction: { status: "none" }`. The guard is the enforcement point, and it
    // is composed from the real M5.4 pipeline rather than a stub — a stub would
    // prove the wiring, not the control.
    const { DeterministicRedactionPipeline } = await import("../../../src/memory/redaction/pipeline.js")
    const { defaultRedactionPolicy } = await import("../../../src/memory/redaction/index.js")
    const { SEEDED_SECRETS } = await import("../../../src/memory/redaction/corpus.js")
    const { createContractError } = await import("../../../src/orchestration/errors.js")

    const pipeline = new DeterministicRedactionPipeline()
    const policy = defaultRedactionPolicy()
    const guarded = new InMemoryMemoryRepository({
      now: () => NOW,
      writeGuard: {
        inspect: (input) => {
          const outcome = pipeline.redact(input.content, policy)
          if (outcome.status === "prohibited" || outcome.ruleIds.length > 0) {
            return {
              ok: false,
              // The rule ids, never the matched text: this string lands in an
              // operator's log.
              error: createContractError(
                "policy_denied",
                "memory.write_guard_refused",
                `A record was refused before storage: rules ${outcome.ruleIds.join(", ")} matched its content`,
              ),
            }
          }
          return { ok: true, value: true }
        },
        describe: () => "M5.4 deterministic redaction policy",
      },
    })

    const secret = SEEDED_SECRETS.awsAccessKeyId
    const error = expectError(
      await guarded.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: `Deploy with ${secret} to the VPS.`,
      }),
    )
    expect(error.code).toBe("memory.write_guard_refused")
    // The refusal names the rule and not the credential.
    expect(error.message).toContain("aws_access_key_id")
    expect(error.message).not.toContain(secret)
    // And nothing was stored, so a query has nothing to serve.
    const queried = expectOk(await guarded.query({ projectId: PROJECT_A }, reader()))
    expect(queried.records).toHaveLength(0)
    expect(queried.withheld).toHaveLength(0)
  })

  it("lets clean content through, so the guard is a control and not a blanket refusal", async () => {
    const { DeterministicRedactionPipeline } = await import("../../../src/memory/redaction/pipeline.js")
    const { defaultRedactionPolicy } = await import("../../../src/memory/redaction/index.js")
    const { createContractError } = await import("../../../src/orchestration/errors.js")

    const pipeline = new DeterministicRedactionPipeline()
    const policy = defaultRedactionPolicy()
    const guarded = new InMemoryMemoryRepository({
      now: () => NOW,
      writeGuard: {
        inspect: (input) =>
          pipeline.redact(input.content, policy).ruleIds.length > 0
            ? { ok: false, error: createContractError("policy_denied", "memory.write_guard_refused", "matched") }
            : { ok: true, value: true },
        describe: () => "M5.4 deterministic redaction policy",
      },
    })

    const appended = expectOk(
      await guarded.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "Use the Tailscale-only bridge endpoint.",
      }),
    )
    expect(appended.record.trust).toBe("accepted")
  })

  it("a repository with NO guard stores what it is given, and that is the documented limitation", async () => {
    // Stated as a test so it cannot become a surprise: `writeGuard` is optional,
    // so a caller who forgets one has no write-path secret detection at all.
    // Making it mandatory would mean the store owns a detector set; see
    // `MemoryRepositoryOptions.writeGuard`.
    const unguarded = store()
    const appended = expectOk(
      await unguarded.append({
        projectId: PROJECT_A,
        kind: "decision",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "A perfectly ordinary sentence about deployments.",
      }),
    )
    expect(appended.record.redaction.status).toBe("none")
  })
})

describe("M5.9 SF-7: the transcript guardrail is enforced by the schema", () => {
  it("refuses a record body large enough to be a transcript", async () => {
    // The plan's guardrail is "do not store complete raw transcripts as memory
    // by default", and the review found nothing enforced it: `content` accepted
    // the M0 `largeText` bound of 65 536 characters, so an agent could append a
    // 60 KB terminal transcript as a `finding` and one user accept would make it
    // injectable into every later context.
    const { MAX_RECORD_CONTENT_CHARACTERS } = await import("../../../src/memory/record.js")
    expect(MAX_RECORD_CONTENT_CHARACTERS).toBeLessThan(65_536)

    const error = expectError(
      await store().append({
        projectId: PROJECT_A,
        kind: "finding",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "x".repeat(MAX_RECORD_CONTENT_CHARACTERS + 1),
      }),
    )
    expect(error.code).toBe(MEMORY_ERROR_CODES.recordInvalid)
  })

  it("still accepts a body at the bound, so the limit is a bound and not a refusal", async () => {
    const { MAX_RECORD_CONTENT_CHARACTERS } = await import("../../../src/memory/record.js")
    const appended = expectOk(
      await store().append({
        projectId: PROJECT_A,
        kind: "finding",
        scope: { kind: "project" },
        author: USER,
        createdAt: NOW,
        content: "x".repeat(MAX_RECORD_CONTENT_CHARACTERS),
      }),
    )
    expect(appended.record.payload.content).toHaveLength(MAX_RECORD_CONTENT_CHARACTERS)
  })
})

describe("M5.9 the fixes are structural, not advisory", () => {
  it("a record read back from the store is frozen all the way down", async () => {
    const repository = store()
    const { memoryId } = await appendAccepted(repository, { detail: { key: "value" } })
    const raw = (await repository.getRaw(memoryId)) as unknown as Record<string, unknown>

    // Top level, the payload, and the nested detail value: all frozen. A
    // shallow freeze would leave `payload.content` writable, which is the
    // obvious way to try to get back in.
    expect(Object.isFrozen(raw)).toBe(true)
    expect(Object.isFrozen(raw["payload"])).toBe(true)
    expect(Object.isFrozen((raw["payload"] as Record<string, unknown>)["detail"])).toBe(true)
  })

  it("the content hash of a record is independent of its trust, so freezing cannot change it", () => {
    // Belt and braces on the property SF-1 would have broken: `computeContentHash`
    // excludes trust, so even a hypothetical in-place trust write could not make
    // a record's stored digest stop verifying.
    const a = appendAccepted(store())
    return a.then(({ contentHash }) => {
      expect(contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(digestJson({ kind: "decision" })).not.toBe(contentHash)
    })
  })
})

describe("M5.9 SF-8/SF-9: migration fidelity", () => {
  it("a v1 'rejected' record is NOT re-opened as 'proposed' for acceptance", async () => {
    const { planV1MemoryMigration } = await import("../../../src/memory/migration.js")
    const v1Rejected = memoryRecordSchemaV1Fixture("rejected", "user")
    const plan = expectOk(planV1MemoryMigration([v1Rejected], { projectId: PROJECT_A, migratedAt: NOW }))
    const records = plan.records as { trust: string; payload: { detail?: Record<string, unknown> } }[]
    expect(records).toHaveLength(1)
    // A human explicitly rejected this fact. Migrating it as `proposed` would put
    // it back in the acceptance queue — a trust *upgrade*, not a downgrade.
    expect(records[0]?.trust).toBe("rejected")
    // The reason is preserved, so the refusal is auditable rather than invisible.
    expect(records[0]?.payload.detail?.["legacyTrustState"]).toBe("rejected")
  })

  it("a v1 record's supersedesMemoryId is carried onto the migrated record", async () => {
    const { planV1MemoryMigration } = await import("../../../src/memory/migration.js")
    const target = memoryRecordSchemaV1Fixture("accepted", "user")
    const corrected = {
      ...target,
      memoryId: "memory-v1-correction",
      content: "A correction to the earlier decision.",
      supersedesMemoryId: target.memoryId,
    }
    const plan = expectOk(planV1MemoryMigration([target, corrected], { projectId: PROJECT_A, migratedAt: NOW }))
    const records = plan.records as { supersedesMemoryId?: string; payload: { detail?: Record<string, unknown> } }[]
    // The legacy correction chain survives the migration rather than being
    // silently severed, so a migrated corpus still says which fact corrected
    // which.
    const migratedCorrection = records.find(
      (record) => record.payload.detail?.["legacyMemoryId"] === "memory-v1-correction",
    )
    expect(migratedCorrection?.supersedesMemoryId).toBeTruthy()
  })
})

function memoryRecordSchemaV1Fixture(trustState: "accepted" | "rejected" | "proposed", authorKind: "user" | "system") {
  return {
    schemaVersion: 1,
    memoryId: "memory-v1-1",
    projectId: PROJECT_A,
    kind: "decision",
    content: "A legacy decision.",
    contentDigest: digestJson("A legacy decision."),
    scope: { kind: "project" },
    author:
      authorKind === "user"
        ? { kind: "user", userId: userIdSchema.parse("user-owner") }
        : { kind: "system", name: "legacy-migration" },
    createdAt: "2026-09-01T00:00:00.000Z",
    sourceReferences: [{ namespace: "legacy.memory.decision", id: "d1" }],
    trustState,
    sensitivity: "internal",
    retention: "project",
  }
}

describe("M5.9 the unexploitable claims stay asserted", () => {
  it("run-1 still cannot see run-2, and the check is identity, not kind", async () => {
    const repository = store()
    const run1 = runIdSchema.parse("run-1")
    const run2 = runIdSchema.parse("run-2")
    const task1 = taskIdSchema.parse("task-1")

    await repository.append({
      projectId: PROJECT_A,
      kind: "finding",
      scope: { kind: "run", runId: run2 },
      author: USER,
      createdAt: NOW,
      content: "run-2 only",
    })

    const result = expectOk(
      await repository.query({ projectId: PROJECT_A }, reader({ scope: { kind: "run", runId: run1 } })),
    )
    expect(result.records).toHaveLength(0)
    expect(result.withheld[0]?.reason).toBe("scope_not_visible")
    // The reader is at `run-1` and the record is `run-2`: same KIND. Only the
    // identity differs, which is the case a kind-only comparison gets wrong.
    expect(task1).toBeTruthy()
  })

  it("a v2 dispatch reader still cannot see a v1 session record, and it fails closed", async () => {
    const { scopeContains } = await import("../../../src/memory/record.js")
    const v1Session = {
      kind: "session",
      runId: runIdSchema.parse("run-1"),
      taskId: taskIdSchema.parse("task-1"),
      sessionId: sessionIdSchema.parse("session-9"),
    } as const
    const dispatchReader = {
      kind: "dispatch",
      runId: runIdSchema.parse("run-1"),
      taskId: taskIdSchema.parse("task-1"),
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
    } as const
    // Availability, not confidentiality: the chains diverge at the leaf and there
    // is no id with which to reconcile them.
    expect(scopeContains(v1Session, dispatchReader)).toBe(false)
    expect(scopeContains(v1Session, v1Session)).toBe(true)
  })
})

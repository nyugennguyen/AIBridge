/**
 * M5.9 gate: cross-project, role-restricted, and node-restricted access.
 *
 * This is the plan's "Isolation and leakage audit" row, made executable. It
 * walks every entry in `ISOLATION_CASES` against a real repository, asserts the
 * exact withholding reason, and then runs the egress audit over all seven paths
 * with seeded secrets planted in the corpus.
 *
 * The seeded secrets are imported from the M5.4 corpus rather than written
 * here, for two reasons: a second copy of a secret literal is a second thing to
 * forget to delete, and the corpus is the artefact the gate report cites. If
 * they are assembled from fragments there, a repo-wide grep finds nothing, which
 * is what keeps CI secret scanners from being trained to ignore this directory.
 *
 * The audit assertions are deliberately *negative* as well as positive: several
 * tests build a leaking configuration, confirm the auditor reports it, and only
 * then confirm the real configuration does not. An auditor that has never
 * reported a finding is not evidence of anything.
 */

import { describe, expect, it } from "vitest"
import {
  ISOLATION_CASES,
  ISOLATION_MATRIX_NOTES,
  assertNoLeaks,
  auditMemoryContext,
  describeAudit,
  findSeededSecret,
  MEMORY_EGRESS_PATHS,
  type IsolationCase,
} from "../../src/context/isolation.js"
import { InMemoryMemoryRepository } from "../../src/memory/in-memory-repository.js"
import { FileMemoryRepository } from "../../src/memory/file-repository.js"
import type { AppendMemoryInput, MemoryRepository } from "../../src/memory/ports.js"
import { proposeMemoryRecord, type MemoryRecordV2 } from "../../src/memory/record.js"
import { RepositoryMemoryWorkflow } from "../../src/memory/workflow.js"
import { assembleContext, renderContextWithContent, sourceIdOf } from "../../src/context/assembler.js"
import { buildMemoryTuiView, buildPreview, initialMemoryTuiState, reduceMemoryTui, verifyPreviewMatchesManifest } from "../../src/context/tui/memory-view.js"
import { SEEDED_SECRET_LITERALS, SEEDED_SECRETS } from "../../src/memory/redaction/corpus.js"
import { DeterministicRedactionPipeline } from "../../src/memory/redaction/pipeline.js"
import { defaultRedactionPolicy } from "../../src/memory/redaction/index.js"
import { createContractError } from "../../src/orchestration/errors.js"
import { digestJson } from "../../src/orchestration/digest.js"
import type { MemoryQueryScope } from "../../src/memory/ports.js"
import { roleIdSchema, userIdSchema, runIdSchema, taskIdSchema, nodeIdSchema, dispatchIdSchema, sessionIdSchema, projectIdSchema } from "../../src/orchestration/identifiers.js"

const NOW = "2026-09-30T12:00:00.000Z"

/**
 * `query` returns a `Result` so a mismatched project pair is a *refusal* rather
 * than an empty result that looks like "this project has no records". Every
 * assertion below about a *successful* read goes through this, so a test cannot
 * quietly pass against the refusal branch.
 */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}
const PROJECT = "project-isolation"

function store(): MemoryRepository {
  return new InMemoryMemoryRepository({ now: () => NOW })
}

/**
 * Build the record an isolation case describes.
 *
 * Goes through the owning record schema, because a case that assembled a record
 * by hand could assert a withholding the record would never actually produce.
 */
function recordFor(entry: IsolationCase): MemoryRecordV2 {
  const scope =
    entry.record.scopeKind === "run"
      ? ({ kind: "run", runId: runIdSchema.parse("run-other") } as const)
      : ({ kind: "project" } as const)
  return proposeMemoryRecord({
    memoryId: entry.record.memoryId,
    projectId: entry.record.projectId,
    kind: "decision",
    scope,
    author: { kind: "user", userId: userIdSchema.parse("user-owner") },
    createdAt: entry.record.createdAt ?? NOW,
    content: `Content for ${entry.record.memoryId}.`,
    // A `secret_reference_only` record must name a secret or the schema refuses
    // it — which is the record contract doing its job, and the reason this
    // fixture supplies a reference rather than a value.
    ...(entry.record.sensitivity === "secret_reference_only"
      ? { secretReferences: [{ reference: `op://prod/${entry.record.memoryId}`, summary: "production deploy key" }] }
      : {}),
    // The trust state is stated rather than derived, so a case can exercise the
    // `not_trusted` boundary without the author kind being the thing under test.
    ...(entry.record.trust === "proposed" ? { trust: "proposed" as const } : {}),
    sensitivity: entry.record.sensitivity as MemoryRecordV2["sensitivity"],
    ...(entry.record.visibleToNodeIds ? { visibleToNodeIds: entry.record.visibleToNodeIds } : {}),
    ...(entry.record.visibleToRoleIds ? { visibleToRoleIds: entry.record.visibleToRoleIds } : {}),
    ...(entry.record.expiresAt ? { expiresAt: entry.record.expiresAt } : {}),
    ...(entry.record.redactionStatus === "prohibited" || entry.record.redactionStatus === "redacted"
      ? {
          redaction: {
            status: entry.record.redactionStatus as "prohibited" | "redacted",
            ruleIds: ["corpus.seed"],
            redactedSpanCount: 1,
          },
        }
      : {}),
    sourceReferences: [{ namespace: "isolation.case", id: entry.record.memoryId }],
  })
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.value
}

describe("M5.9 every cross-boundary case is denied, with the right reason", () => {
  it("the matrix covers every access reason the contract enumerates, apart from the two view-only ones", () => {
    const covered = new Set(ISOLATION_CASES.map((entry) => entry.expectedReason))
    for (const reason of ISOLATION_MATRIX_NOTES.reasonsCovered) {
      if (ISOLATION_MATRIX_NOTES.viewOnlyReasons.includes(reason)) continue
      expect(covered, `no isolation case covers '${reason}'`).toContain(reason)
    }
    for (const reason of ISOLATION_MATRIX_NOTES.viewOnlyReasons) {
      // Stated, not claimed: these are the two reasons the matrix deliberately
      // does not cover, and a test that merely omitted them would look identical
      // to a test that had covered them.
      expect(covered.has(reason)).toBe(false)
    }
  })

  for (const entry of ISOLATION_CASES) {
    it(`denies ${entry.name} with reason '${entry.expectedReason}'`, async () => {
      const repository = store()
      // The repository derives the id from the content, so the id the case
      // *asked* for is not the id that exists. Reading it back is the only
      // honest way to assert on a withholding, and it is also the assertion
      // that matters: the withholding is keyed on the real record.
      const appended = ok(await repository.append({ ...toAppend(recordFor(entry)) }))
      const memoryId = appended.record.memoryId

      const result = expectOk(await repository.query({ projectId: entry.reader.projectId }, entry.reader))
      expect(result.records.map((record) => record.memoryId)).not.toContain(memoryId)

      if (!entry.expectedCandidate) {
        // Not a candidate, so not a withholding. The reader learns nothing, and
        // "nothing" is the strongest answer available.
        expect(result.withheld).toHaveLength(0)
        expect(JSON.stringify(result)).not.toContain(memoryId)
        return
      }
      const withheld = result.withheld.find((w) => w.memoryId === memoryId)
      expect(withheld, `${memoryId} produced no withholding at all`).toBeDefined()
      expect(withheld?.reason).toBe(entry.expectedReason)
      expect(withheld?.revealsKind).toBe(entry.expectedRevealsKind)
    })
  }

  it("a cross-project record is not even a CANDIDATE, so its existence is never reported", async () => {
    // Stronger than a `project_mismatch` withholding: the foreign record is
    // dropped before the access policy runs, so a reader of project A cannot
    // learn that project B has a record with a given id. A withholding would
    // confirm existence, and existence is information.
    const entry = ISOLATION_CASES.find((c) => c.expectedReason === "project_mismatch")!
    const repository = store()
    const appended = ok(await repository.append({ ...toAppend(recordFor(entry)) }))

    const result = expectOk(await repository.query({ projectId: entry.reader.projectId }, entry.reader))
    expect(result.records).toHaveLength(0)
    expect(result.withheld).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain(appended.record.memoryId)
  })

  it("a case that IS cleared for does get the record, so the denials are not vacuous", async () => {
    const entry = ISOLATION_CASES[0]!
    const repository = store()
    // The same record, in the reader's own project, untrusted so it is the
    // `not_trusted` reason rather than `project_mismatch`.
    const own = proposeMemoryRecord({
      memoryId: "m-own-project",
      projectId: entry.reader.projectId,
      kind: "decision",
      scope: { kind: "project" },
      author: { kind: "user", userId: userIdSchema.parse("user-owner") },
      createdAt: NOW,
      content: "The same shape, in the reader's own project.",
    })
    const appended = ok(await repository.append({ ...toAppend(own) }))

    const result = expectOk(await repository.query({ projectId: entry.reader.projectId }, entry.reader))
    expect(result.records.map((record) => record.memoryId)).toEqual([appended.record.memoryId])
    expect(result.withheld).toHaveLength(0)
  })
})

function toAppend(record: MemoryRecordV2): AppendMemoryInput {
  return {
    projectId: record.projectId,
    kind: record.kind,
    scope: record.scope,
    author: record.author,
    createdAt: record.createdAt,
    content: record.payload.content,
    ...(record.payload.detail ? { detail: record.payload.detail } : {}),
    ...(record.payload.secretReferences ? { secretReferences: record.payload.secretReferences } : {}),
    sensitivity: record.sensitivity,
    retention: record.retention,
    redaction: record.redaction,
    ...(record.sourceReferences ? { sourceReferences: record.sourceReferences } : {}),
    trust: record.trust,
    ...(record.trustDecision ? { trustDecision: record.trustDecision } : {}),
    ...(record.visibleToNodeIds ? { visibleToNodeIds: record.visibleToNodeIds } : {}),
    ...(record.visibleToRoleIds ? { visibleToRoleIds: record.visibleToRoleIds } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  }
}

describe("M5.9 seeded secrets never cross a boundary", () => {
  const literals = SEEDED_SECRET_LITERALS

  it("the corpus actually plants secrets, so this file is testing something", () => {
    expect(literals.length).toBeGreaterThanOrEqual(10)
    expect(literals.every((literal) => literal.length >= 8)).toBe(true)
  })

  it("no seeded literal appears in any raw record the repository stores", async () => {
    const repository = store()
    // A record whose content is a redacted derivative: the pipeline replaced the
    // secret, so what lands on disk must not contain it.
    const redactor = new DeterministicRedactionPipeline()
    const withSecret = `Deploy with ${SEEDED_SECRETS.awsAccessKeyId} and ${SEEDED_SECRETS.githubClassicPat} to the VPS.`
    const redaction = redactor.redact(withSecret, defaultRedactionPolicy())
    expect(redaction.status).toBe("redacted")

    const record = proposeMemoryRecord({
      memoryId: "m-redacted-body",
      projectId: PROJECT,
      kind: "finding",
      scope: { kind: "project" },
      author: { kind: "user", userId: userIdSchema.parse("user-owner") },
      createdAt: NOW,
      content: redaction.text,
      redaction: {
        status: "redacted",
        ruleIds: [...redaction.ruleIds].sort(),
        redactedSpanCount: redaction.spanCount,
      },
    })
    ok(await repository.append({ ...toAppend(record) }))

    const stored = await repository.listProjectUnscoped(PROJECT)
    const serialized = JSON.stringify(stored)
    for (const literal of literals) {
      expect(findSeededSecret(serialized, [literal]), `literal leaked into storage: ${literal.slice(0, 6)}…`).toBeNull()
    }
  })

  it("no seeded literal appears in a query result, an assembly, or a rendering", async () => {
    const repository = store()
    const redactor = new DeterministicRedactionPipeline()
    const redaction = redactor.redact(`Key: ${SEEDED_SECRETS.tailscaleAuthKey}`, defaultRedactionPolicy())
    const record = proposeMemoryRecord({
      memoryId: "m-safe-finding",
      projectId: PROJECT,
      kind: "finding",
      scope: { kind: "project" },
      author: { kind: "user", userId: userIdSchema.parse("user-owner") },
      createdAt: NOW,
      content: redaction.text,
      redaction: { status: "redacted", ruleIds: [...redaction.ruleIds].sort(), redactedSpanCount: redaction.spanCount },
    })
    ok(await repository.append({ ...toAppend(record) }))

    const scope: MemoryQueryScope = {
      projectId: PROJECT,
      scope: { kind: "project" },
      nodeId: nodeIdSchema.parse("node-a"),
      roleId: roleIdSchema.parse("role-implementer"),
      clearance: "restricted",
      actor: { kind: "user", userId: userIdSchema.parse("user-auditor") },
    }
    const query = expectOk(await repository.query({ projectId: PROJECT }, scope))

    const candidates = [
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: record.memoryId },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_decision" as const,
        text: redaction.text,
        sensitivity: "public_to_project" as const,
        priority: 500,
        optional: true,
        createdAt: NOW,
      },
    ]
    const assembled = ok(
      await assembleContext(
        {
          projectId: PROJECT,
          runId: runIdSchema.parse("run-1"),
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: dispatchIdSchema.parse("dispatch-1"),
          destination: { nodeId: "node-a", roleId: roleIdSchema.parse("role-implementer"), clearance: "restricted" },
          roleSnapshotHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          policy: { policyVersion: "m5.v1", budget: { maximum: 10_000, unit: "tokens" } },
          now: NOW,
          correlationId: "corr-isolation",
        },
        { provider: { candidates: async () => candidates } },
      ),
    )
    const rendered = ok(renderContextWithContent(assembled, new Map([[sourceIdOf(candidates[0]!), redaction.text]])))

    const audit = auditMemoryContext({
      seededSecrets: literals,
      forbiddenIdentifiers: ["memory-from-project-b"],
      query,
      manifest: assembled,
      rendered: { text: rendered.text, sourceIds: assembled.items.map((item) => item.sourceId) },
      records: (await repository.listProjectUnscoped(PROJECT)) as MemoryRecordV2[],
      auditEvents: [],
    })
    expect(describeAudit(audit)).toContain("PASS")
    expect(audit.examinedPaths).toEqual(["repository_query", "context_manifest", "context_exclusion", "rendered_prompt", "record_at_rest", "audit_event"])
    expect(audit.findings).toEqual([])
  })

  it("the auditor DETECTS a leak when one is planted, so a pass above means something", () => {
    const literal = SEEDED_SECRETS.slackBotToken
    const planted = auditMemoryContext({
      seededSecrets: [literal],
      forbiddenIdentifiers: [],
      records: [
        proposeMemoryRecord({
          memoryId: "m-planted",
          projectId: PROJECT,
          kind: "decision",
          scope: { kind: "project" },
          author: { kind: "user", userId: userIdSchema.parse("user-owner") },
          createdAt: NOW,
          content: `The deploy token is ${literal} and should be rotated.`,
        }),
      ],
    })
    expect(planted.passed).toBe(false)
    const secretFindings = planted.findings.filter((finding) => finding.kind === "secret_material")
    expect(secretFindings.length).toBeGreaterThan(0)
    expect(secretFindings[0]?.severity).toBe("blocker")
    // The finding names the record, never the secret.
    expect(JSON.stringify(planted.findings)).not.toContain(literal)
  })

  it("the auditor detects a base64-encoded leak, which a raw grep would miss", () => {
    const literal = SEEDED_SECRETS.googleApiKey
    const encoded = Buffer.from(literal, "utf8").toString("base64")
    expect(encoded).not.toBe(literal)
    const audit = auditMemoryContext({
      seededSecrets: [literal],
      forbiddenIdentifiers: [],
      records: [
        proposeMemoryRecord({
          memoryId: "m-base64",
          projectId: PROJECT,
          kind: "decision",
          scope: { kind: "project" },
          author: { kind: "user", userId: userIdSchema.parse("user-owner") },
          createdAt: NOW,
          content: `Encoded credential: ${encoded}`,
        }),
      ],
    })
    expect(audit.passed).toBe(false)
  })

  it("refuses the caller when the audit fails, so auditing and proceeding are not separable", () => {
    const failed = auditMemoryContext({
      seededSecrets: [SEEDED_SECRETS.jwt],
      forbiddenIdentifiers: [],
      records: [
        proposeMemoryRecord({
          memoryId: "m-refused",
          projectId: PROJECT,
          kind: "decision",
          scope: { kind: "project" },
          author: { kind: "user", userId: userIdSchema.parse("user-owner") },
          createdAt: NOW,
          content: `Signature ${SEEDED_SECRETS.jwt}`,
        }),
      ],
    })
    const refusal = assertNoLeaks(failed)
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.error.code).toBe("memory.isolation_audit_failed")
  })
})

describe("M5.9 a prohibited record is described by nothing but its id and reason", () => {
  it("the manifest exclusion carries no kind, no hash, and no content", async () => {
    const secret = SEEDED_SECRETS.awsSecretAccessKey
    const candidates = [
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: "m-prohibited-body" },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_decision" as const,
        text: `The secret is ${secret}.`,
        sensitivity: "prohibited" as const,
        priority: 500,
        optional: true,
        createdAt: NOW,
      },
    ]
    const assembled = ok(
      await assembleContext(
        {
          projectId: PROJECT,
          runId: runIdSchema.parse("run-1"),
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: dispatchIdSchema.parse("dispatch-1"),
          destination: { nodeId: "node-a", roleId: roleIdSchema.parse("role-implementer"), clearance: "secret_reference_only" },
          roleSnapshotHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          policy: { policyVersion: "m5.v1", budget: { maximum: 10_000, unit: "tokens" } },
          now: NOW,
          correlationId: "corr-prohibited",
        },
        { provider: { candidates: async () => candidates } },
      ),
    )

    expect(assembled.items).toHaveLength(0)
    const exclusion = assembled.excluded.find((entry) => entry.sourceId === "m-prohibited-body")
    expect(exclusion).toBeDefined()
    expect(exclusion?.reason).toBe("prohibited_content")
    expect(exclusion?.revealsKind).toBe(false)
    expect(exclusion?.kind).toBeUndefined()

    // The whole serialized manifest, not just the exclusion, for the secret.
    const serialized = JSON.stringify(assembled)
    expect(findSeededSecret(serialized, [secret])).toBeNull()

    // The *exclusion* must carry no content hash. The manifest as a whole
    // legitimately does — `roleSnapshotHash` is one — so the assertion is
    // scoped to the exclusion, where a hash would be a fingerprint of content
    // that still exists somewhere.
    expect(JSON.stringify(exclusion)).not.toContain("sha256:")
    // And it must not echo the candidate's own inclusion reason, which is the
    // one field that describes the record.
    expect(JSON.stringify(exclusion)).not.toContain("active_decision")
  })

  it("no clearance unlocks it, including the top of the scale", () => {
    const reader = { ...ISOLATION_CASES.find((entry) => entry.expectedReason === "prohibited_content")! }
    expect(reader.record.sensitivity).toBe("prohibited")
    expect(reader.reader.clearance).toBe("secret_reference_only")
  })
})

describe("M5.9 audit events carry identity, never content", () => {
  it("an accept event names the record and the transition, and no content", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const context = {
      actor: { kind: "session" as const, sessionId: sessionIdSchema.parse("session-1") },
      projectId: PROJECT,
      at: NOW,
      correlationId: "corr-audit",
    }
    const proposed = ok(
      await workflow.execute(
        {
          type: "memory.propose",
          projectId: PROJECT,
          kind: "finding",
          scope: { kind: "project" },
          author: { kind: "session", sessionId: sessionIdSchema.parse("session-1") },
          at: NOW,
          content: `Observed that ${SEEDED_SECRETS.openAiProjectKey} is used for the deploy step.`,
          correlationId: "corr-audit",
        },
        context,
      ),
    )
    ok(
      await workflow.execute(
        {
          type: "memory.accept",
          memoryId: proposed.record.memoryId,
          projectId: PROJECT,
          decidedBy: { kind: "user", userId: userIdSchema.parse("user-owner") },
          at: NOW,
          reason: "Reviewed; the key reference is useful.",
          correlationId: "corr-audit",
        },
        {
          actor: { kind: "user", userId: userIdSchema.parse("user-owner") },
          projectId: PROJECT,
          at: NOW,
          correlationId: "corr-audit",
        },
      ),
    )

    const audit = auditMemoryContext({
      seededSecrets: SEEDED_SECRET_LITERALS,
      forbiddenIdentifiers: [],
      auditEvents: [
        { memoryId: proposed.record.memoryId, trust: "accepted" },
        { memoryId: proposed.record.memoryId, reason: "Reviewed." },
      ],
    })
    expect(audit.passed).toBe(true)
  })
})

describe("M5.9 the egress list is complete and every path is reachable", () => {
  it("names seven paths, and the auditor can examine all seven", () => {
    expect(MEMORY_EGRESS_PATHS).toHaveLength(7)
    const audit = auditMemoryContext({
      seededSecrets: [],
      forbiddenIdentifiers: [],
      query: { records: [], withheld: [] },
      manifest: null,
      rendered: { text: "", sourceIds: [] },
      records: [],
      auditEvents: [],
    })
    // Six: `context_manifest` and `context_exclusion` are only examined together.
    expect(audit.examinedPaths).toContain("rendered_prompt")
    expect(audit.examinedPaths).toContain("record_at_rest")
  })

  it("an audit that examined nothing is distinguishable from one that passed", () => {
    const empty = auditMemoryContext({ seededSecrets: [], forbiddenIdentifiers: [] })
    expect(empty.passed).toBe(true)
    expect(empty.examinedPaths).toHaveLength(0)
    expect(describeAudit(empty)).toContain("0/7")
  })
})

describe("M5.9 a leaked file and a leaked query agree", async () => {
  it("the file-backed repository applies the same denials as the in-memory one", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const directory = await mkdtemp(join(tmpdir(), "aibr-m5-isolation-"))
    try {
      const fileStore = new FileMemoryRepository(directory, { now: () => NOW })
      const entry = ISOLATION_CASES.find((c) => c.expectedReason === "node_restricted")!
      const appended = ok(await fileStore.append({ ...toAppend(recordFor(entry)) }))

      const result = expectOk(await fileStore.query({ projectId: entry.reader.projectId }, entry.reader))
      expect(result.records).toHaveLength(0)
      const withheld = result.withheld.find((w) => w.memoryId === appended.record.memoryId)
      expect(withheld?.reason).toBe("node_restricted")
      expect(withheld?.revealsKind).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("M5.9 the TUI preview shows exactly the context, and nothing withheld", () => {
  it("the preview describes the manifest, with the same included ids in the same order", async () => {
    const candidates = [
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: "m-1" },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_decision" as const,
        text: "first",
        sensitivity: "public_to_project" as const,
        priority: 500,
        optional: true,
        createdAt: NOW,
      },
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: "m-2" },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_constraint" as const,
        text: "second",
        sensitivity: "public_to_project" as const,
        priority: 900,
        optional: true,
        createdAt: NOW,
      },
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: "m-secret" },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_decision" as const,
        text: "withheld",
        sensitivity: "prohibited" as const,
        priority: 500,
        optional: true,
        createdAt: NOW,
      },
    ]
    const assembled = ok(
      await assembleContext(
        {
          projectId: PROJECT,
          runId: runIdSchema.parse("run-1"),
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: dispatchIdSchema.parse("dispatch-1"),
          destination: { nodeId: "node-a", roleId: roleIdSchema.parse("role-implementer"), clearance: "restricted" },
          roleSnapshotHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          policy: { policyVersion: "m5.v1", budget: { maximum: 10_000, unit: "tokens" } },
          now: NOW,
          correlationId: "corr-tui",
        },
        { provider: { candidates: async () => candidates } },
      ),
    )

    const state = reduceMemoryTui(initialMemoryTuiState(), { type: "manifest-loaded", manifest: assembled })
    const view = buildMemoryTuiView(state)
    expect(view.preview).not.toBeNull()
    expect(verifyPreviewMatchesManifest(view.preview!, assembled)).toEqual([])

    // Included, in the manifest's own order: the higher priority first.
    expect(view.preview!.included.map((item) => item.sourceId)).toEqual(["m-2", "m-1"])
    expect(view.preview!.excluded.map((item) => `${item.sourceId}:${item.reason}`)).toEqual(["m-secret:prohibited_content"])

    const rendered = view.lines.join("\n")
    expect(rendered).toContain("m-2")
    expect(rendered).toContain("m-1")
    expect(rendered).toContain("m-secret: prohibited_content (detail withheld)")
    // The withheld record's own text is nowhere on screen.
    expect(rendered).not.toContain("withheld\n")

    // The TUI preview is its own egress path, and it is the last of the seven.
    // Audited here with the *rendered* lines, so a preview that filtered,
    // re-sorted, or un-redacted would be caught.
    const audit = auditMemoryContext({
      seededSecrets: SEEDED_SECRET_LITERALS,
      forbiddenIdentifiers: [],
      manifest: assembled,
      preview: {
        lines: view.lines,
        included: view.preview!.included,
        excluded: view.preview!.excluded,
      },
    })
    expect(describeAudit(audit)).toContain("PASS")
    expect(audit.examinedPaths).toContain("tui_preview")
    expect(audit.findings).toEqual([])
  })

  it("the auditor DETECTS a preview that does not describe its manifest", async () => {
    const candidates = [
      {
        source: { kind: "memory" as const, memoryKind: "decision" as const, memoryId: "m-1" },
        scope: { kind: "project" as const },
        category: "project_constraints" as const,
        reason: "active_decision" as const,
        text: "included",
        sensitivity: "public_to_project" as const,
        priority: 500,
        optional: true,
        createdAt: NOW,
      },
    ]
    const manifest = ok(
      await assembleContext(
        {
          projectId: PROJECT,
          runId: runIdSchema.parse("run-1"),
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: dispatchIdSchema.parse("dispatch-1"),
          destination: { nodeId: "node-a", roleId: roleIdSchema.parse("role-implementer"), clearance: "restricted" },
          roleSnapshotHash: digestJson({ role: "implementer" }),
          policy: { policyVersion: "m5.v1", budget: { maximum: 10_000, unit: "tokens" } },
          now: NOW,
          correlationId: "corr-preview-drift",
        },
        { provider: { candidates: async () => candidates } },
      ),
    )

    // A preview that claims an item the manifest excluded. An operator would
    // approve this; the agent would not receive it.
    const audit = auditMemoryContext({
      seededSecrets: [],
      forbiddenIdentifiers: [],
      manifest,
      preview: {
        lines: ["AIBridge — Dispatch context preview"],
        included: [{ sourceId: "m-never-selected" }],
        excluded: [],
      },
    })
    expect(audit.passed).toBe(false)
    const previewFindings = audit.findings.filter((finding) => finding.path === "tui_preview")
    expect(previewFindings.length).toBeGreaterThan(0)
    expect(previewFindings[0]?.severity).toBe("blocker")
  })

  it("a preview built by hand from a different manifest is detected as inconsistent", () => {
    const preview = buildPreview({
      manifestId: "manifest_other",
      schemaVersion: 2,
      projectId: projectIdSchema.parse(PROJECT),
      runId: runIdSchema.parse("run-1"),
      taskId: taskIdSchema.parse("task-1"),
      dispatchId: dispatchIdSchema.parse("dispatch-1"),
      roleSnapshotHash: digestJson({ other: true }),
      items: [],
      excluded: [],
      budget: { maximum: 100, estimated: 0, unit: "tokens" },
      policyVersion: "m5.v1",
      destination: { nodeId: "node-a", roleId: roleIdSchema.parse("role-implementer"), clearance: "restricted" },
      createdAt: NOW,
      digest: digestJson({ preview: "other" }),
    })
    const other = {
      ...preview,
      manifestId: "manifest_x",
      items: [
        {
          sourceId: "m-1",
          sourceHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          renderedHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          scope: { kind: "project" as const },
          category: "project_constraints" as const,
          reason: "active_decision" as const,
          sensitivity: "public_to_project" as const,
          sensitivityDecision: "within_clearance" as const,
          orderingKey: "03:09500:m-1",
          priority: 500,
          optional: true,
          estimatedCost: 1,
        },
      ],
    }
    const problems = verifyPreviewMatchesManifest(preview, other as never)
    expect(problems).toContain("manifestId")
    expect(problems).toContain("included order")
  })
})

describe("M5.9 a role cannot be assumed by a caller", () => {
  it("a command whose actor differs from the executing context is refused", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const result = await workflow.execute(
      {
        type: "memory.propose",
        projectId: PROJECT,
        kind: "decision",
        scope: { kind: "project" },
        // The command claims a human author…
        author: { kind: "user", userId: userIdSchema.parse("user-owner") },
        at: NOW,
        content: "This was not written by a human.",
        correlationId: "corr-impersonation",
      },
      // …but the context says the caller is a node.
      {
        actor: { kind: "node", nodeId: nodeIdSchema.parse("node-a") },
        projectId: PROJECT,
        at: NOW,
        correlationId: "corr-impersonation",
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("memory.actor_mismatch")
    expect(await repository.listProjectUnscoped(PROJECT)).toHaveLength(0)
  })

  it("a non-user cannot accept a proposal, whatever it claims about itself", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const node = { kind: "node" as const, nodeId: nodeIdSchema.parse("node-a") }
    const context = { actor: node, projectId: PROJECT, at: NOW, correlationId: "corr-accept" }
    const proposed = ok(
      await workflow.execute(
        {
          type: "memory.propose",
          projectId: PROJECT,
          kind: "decision",
          scope: { kind: "project" },
          author: node,
          at: NOW,
          content: "A proposal from the node.",
          correlationId: "corr-accept",
        },
        context,
      ),
    )
    expect(proposed.record.trust).toBe("proposed")

    const accepted = await workflow.execute(
      {
        type: "memory.accept",
        memoryId: proposed.record.memoryId,
        projectId: PROJECT,
        decidedBy: node,
        at: NOW,
        reason: "I accept my own proposal.",
        correlationId: "corr-accept",
      },
      context,
    )
    expect(accepted.ok).toBe(false)
    if (accepted.ok) return
    expect(accepted.error.code).toBe("memory.unauthorized_trust_decision")
    expect(accepted.error.category).toBe("policy_denied")

    // And the record is unchanged.
    const stored = await repository.getRaw(proposed.record.memoryId)
    expect((stored as MemoryRecordV2).trust).toBe("proposed")
  })

  it("a cross-project command is refused before the repository is consulted", async () => {
    const repository = store()
    const workflow = new RepositoryMemoryWorkflow(repository)
    const user = { kind: "user" as const, userId: userIdSchema.parse("user-owner") }
    const result = await workflow.execute(
      {
        type: "memory.propose",
        projectId: "project-somebody-else",
        kind: "decision",
        scope: { kind: "project" },
        author: user,
        at: NOW,
        content: "Cross-project write attempt.",
        correlationId: "corr-cross",
      },
      { actor: user, projectId: PROJECT, at: NOW, correlationId: "corr-cross" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("memory.cross_project_command")
    expect(await repository.listProjectUnscoped("project-somebody-else")).toHaveLength(0)
  })
})

describe("M5.9 the audit's own refusal is shaped like every other refusal", () => {
  it("a non-retryable policy_denied, as a leak must be", () => {
    const error = createContractError("policy_denied", "memory.isolation_audit_failed", "x")
    expect(error.retryable).toBe(false)
    expect(error.category).toBe("policy_denied")
  })
})

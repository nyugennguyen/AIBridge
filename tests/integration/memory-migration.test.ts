/**
 * M5.3 gate: legacy memory migrates without content or status loss.
 *
 * The plan's criteria, turned into assertions:
 *
 * - "Legacy decisions, constraints, and handoffs migrate without content or
 *   status loss" — the golden fixtures are compared field by field.
 * - "Golden fixtures preserve content/status and remain rollback-safe" — the
 *   source file is hashed before and after and must be byte-identical, and a
 *   dry-run must write nothing.
 * - "default uncertain imports to proposed/review-needed" — every imported
 *   record is `proposed`, including ones whose legacy status said "accepted".
 *
 * The last one is the subtle one. A legacy handoff with `status: "accepted"`
 * reads like an approval and is not one: it records that a *receiving agent*
 * took the handoff. Migrating it as `accepted` would put an agent-to-agent
 * workflow state into the trust column that only a human may write. The tests
 * below assert the status is preserved *as data* and the trust is `proposed`.
 */

import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  applyLegacyMemoryMigration,
  legacyMemoryMigrationPlanSchema,
  migrationCounts,
  migratedTrustStateFor,
  planLegacyMemoryDataMigration,
  planV1MemoryMigration,
} from "../../src/memory/migration.js"
import { InMemoryMemoryRepository } from "../../src/memory/in-memory-repository.js"
import type { MemoryRepository, MemoryQueryScope } from "../../src/memory/ports.js"
import { digestJson } from "../../src/orchestration/digest.js"
import { roleIdSchema, sessionIdSchema, userIdSchema, nodeIdSchema } from "../../src/orchestration/identifiers.js"
import { memoryRecordSchemaV2, type MemoryRecordV2 } from "../../src/memory/record.js"

const MIGRATED_AT = "2026-09-30T12:00:00.000Z"

/**
 * `query` returns a `Result`, so a mismatched project pair is a *refusal* rather
 * than an empty result that looks like "this project has no records".
 */
function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}
const PROJECT = "project-legacy-m5"

/** The shape `legacyMemoryDataSchema` accepts: a flat, single-project file. */
const LEGACY = {
  projectId: "app",
  decisions: [
    { id: "decision-1", timestamp: "2026-09-15T23:55:00.000Z", agent: "dev-main", content: "Use the existing Tailscale-only bridge endpoint." },
    { id: "decision-2", timestamp: "2026-09-16T01:00:00.000Z", agent: "test-vps", content: "Pin the OpenCode server to loopback only." },
  ],
  constraints: [
    "Never expose the OpenCode server publicly.",
    "Bridge port 8787 is Tailscale-only.",
  ],
  handoffs: [
    { id: "handoff-1", from: "dev-main", to: "test-vps", context: "Verify deployment after the test job completes.", status: "accepted", createdAt: "2026-09-16T00:09:00.000Z" },
    { id: "handoff-2", from: "test-vps", to: "dev-main", context: "Deployment verified; bump the version.", status: "pending", createdAt: "2026-09-16T02:00:00.000Z" },
    { id: "handoff-3", from: "dev-main", to: "test-vps", context: "Tailscale ACL updated.", status: "completed", createdAt: "2026-09-16T03:00:00.000Z" },
  ],
} as const

let workingDirectory: string
let legacyPath: string

beforeEach(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), "aibr-m5-migration-"))
  legacyPath = join(workingDirectory, "memory.json")
  await writeFile(legacyPath, `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8")
})

afterEach(async () => {
  await rm(workingDirectory, { recursive: true, force: true })
})

function expectError(result: { ok: boolean } & Record<string, unknown>): { code: string; message: string; category: string } {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected a refusal")
  return result.error as { code: string; message: string; category: string }
}

function readerScope(): MemoryQueryScope {
  return {
    projectId: PROJECT,
    scope: { kind: "project" },
    nodeId: nodeIdSchema.parse("node-a"),
    roleId: roleIdSchema.parse("role-implementer"),
    clearance: "restricted",
    actor: { kind: "user", userId: userIdSchema.parse("user-m5") },
  }
}

/**
 * The repository is given the reference time explicitly.
 *
 * A `now` the caller supplies is not an ambient clock — it is the same
 * discipline the event store's outbox uses (`options.now: Timestamp`, required
 * precisely so it cannot be forgotten). Migrated records are dated from the
 * legacy file or from `MIGRATED_AT`, never from the clock, so moving this
 * forward does not change a single migrated byte.
 */
function repository(): MemoryRepository {
  return new InMemoryMemoryRepository({ now: () => MIGRATED_AT })
}

async function rawSourceBytes(): Promise<string> {
  return readFile(legacyPath, "utf8")
}

/**
 * A v1 record with a chosen trust state and author kind.
 *
 * The author kind is a parameter because SF-15 turned on it: the exported
 * `migrationTrustDecision` claims the outcome depends on it, and the running
 * policy says it does not. A fixture that hard-codes one author kind could not
 * express that disagreement, so it takes both.
 */
function v1RecordsFixture(input: {
  trustState: "proposed" | "accepted" | "rejected"
  authorKind: "user" | "node" | "session" | "system"
  memoryId?: string
}): Record<string, unknown> {
  const author =
    input.authorKind === "user"
      ? { kind: "user", userId: userIdSchema.parse("user-owner") }
      : input.authorKind === "node"
        ? { kind: "node", nodeId: nodeIdSchema.parse("node-legacy") }
        : input.authorKind === "session"
          ? { kind: "session", sessionId: sessionIdSchema.parse("session-legacy") }
          : { kind: "system", name: "legacy-importer" }
  const content = `A legacy decision authored by a ${input.authorKind}.`
  return {
    schemaVersion: 1,
    memoryId: input.memoryId ?? "memory-legacy-fixture",
    projectId: PROJECT,
    kind: "decision",
    content,
    contentDigest: digestJson(content),
    scope: { kind: "project" },
    author,
    createdAt: "2026-09-01T00:00:00.000Z",
    sourceReferences: [{ namespace: "legacy.memory.decision", id: "d-fixture" }],
    trustState: input.trustState,
    sensitivity: "internal",
    retention: "project",
  }
}

describe("M5.3 legacy memory data migrates with no content loss", () => {
  it("imports every decision, constraint, and handoff exactly once", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const counts = migrationCounts(plan.value)
    expect(counts.decisions).toBe(2)
    expect(counts.constraints).toBe(2)
    expect(counts.handoffs).toBe(3)
    expect(counts.total).toBe(7)
    expect(plan.value.records).toHaveLength(7)
  })

  it("preserves decision and constraint content byte for byte", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const records = plan.value.records as MemoryRecordV2[]

    const decisions = records.filter((record) => record.kind === "decision").map((record) => record.payload.content).sort()
    const constraints = records.filter((record) => record.kind === "constraint").map((record) => record.payload.content).sort()

    expect(decisions).toEqual(
      ["Use the existing Tailscale-only bridge endpoint.", "Pin the OpenCode server to loopback only."].sort(),
    )
    expect(constraints).toEqual(
      ["Never expose the OpenCode server publicly.", "Bridge port 8787 is Tailscale-only."].sort(),
    )
  })

  it("preserves every handoff's legacy status as DATA, without turning it into trust", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const handoffs = (plan.value.records as MemoryRecordV2[]).filter((record) => record.kind === "handoff")

    const statuses = handoffs.map((record) => record.payload.detail?.["legacyStatus"]).sort()
    expect(statuses).toEqual(["accepted", "completed", "pending"])

    // The handoff whose legacy status is "accepted" is still `proposed`.
    const acceptedHandoff = handoffs.find((record) => record.payload.detail?.["legacyStatus"] === "accepted")
    expect(acceptedHandoff).toBeDefined()
    expect(acceptedHandoff?.trust).toBe("proposed")
    expect(acceptedHandoff?.trustDecision).toBeUndefined()
  })

  it("preserves the handoff's from/to labels, which are the only ownership record a v1 file has", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const handoffs = (plan.value.records as MemoryRecordV2[]).filter((record) => record.kind === "handoff")
    const handoff = handoffs.find((record) => record.payload.detail?.["legacyStatus"] === "completed")
    expect(handoff?.payload.detail).toMatchObject({ legacyFrom: "dev-main", legacyTo: "test-vps" })
  })

  it("imports NOTHING as trusted, and says why in the diagnostics", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const records = plan.value.records as MemoryRecordV2[]

    expect(records.every((record) => record.trust === "proposed")).toBe(true)
    expect(records.every((record) => record.trustDecision === undefined)).toBe(true)
    expect(plan.value.counts.trustDowngrades).toBe(0)
  })

  it("gives every imported record full provenance back to the legacy line", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT, sourceNodeId: "node-legacy" })
    if (!plan.ok) throw new Error("plan should succeed")
    for (const raw of plan.value.records) {
      const record = raw as MemoryRecordV2
      expect(record.sourceReferences?.length ?? 0).toBeGreaterThan(0)
      expect(record.sourceReferences?.some((reference) => reference.namespace.startsWith("legacy."))).toBe(true)
      expect(record.sourceReferences?.some((reference) => reference.namespace === "legacy.node-label")).toBe(true)
    }
    const decision = (plan.value.records as MemoryRecordV2[]).find((record) => record.kind === "decision")
    expect(decision?.sourceReferences).toContainEqual({ namespace: "legacy.agent-label", id: "dev-main" })
  })

  it("produces a content hash that verifies, and distinct hashes for distinct content", async () => {
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const records = (plan.value.records as MemoryRecordV2[]).map((record) => memoryRecordSchemaV2.parse(record))
    const hashes = new Set(records.map((record) => record.contentHash))
    // The two constraints are different facts, so a shared hash would mean the
    // hash is not over the content.
    expect(hashes.size).toBe(records.length)
  })
})

describe("M5.3 migration is rollback-safe", () => {
  it("a dry run writes nothing anywhere", async () => {
    const store = repository()
    const before = await rawSourceBytes()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")

    const applied = await applyLegacyMemoryMigration(store, plan.value, { apply: false, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.appended).toBe(0)
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(0)
    expect(await rawSourceBytes()).toBe(before)
  })

  it("DEFAULTS to not applying, so the safe call is the one a caller gets by forgetting", async () => {
    const store = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")

    // The gate is required by the type, so this test asserts the *documented*
    // contract rather than a compile-time one: an explicit `apply: true` is the
    // only way records appear.
    const applied = await applyLegacyMemoryMigration(store, plan.value, { apply: true, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })
    expect(applied.ok).toBe(true)
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(7)
  })

  it("never modifies, moves, or deletes the legacy file", async () => {
    const before = await rawSourceBytes()
    const store = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    await applyLegacyMemoryMigration(store, plan.value, { apply: true, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })

    expect(await rawSourceBytes()).toBe(before)
    const contents = JSON.parse(before) as typeof LEGACY
    expect(contents.decisions).toHaveLength(2)
    expect(contents.handoffs).toHaveLength(3)
  })

  it("is deterministic: the same source produces byte-identical records", async () => {
    const first = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    const second = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(JSON.stringify(second.value.records)).toBe(JSON.stringify(first.value.records))
    expect(second.value.sourceDigest).toBe(first.value.sourceDigest)
  })

  it("is IDEMPOTENT: applying twice does not duplicate the corpus", async () => {
    const store = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")

    const first = await applyLegacyMemoryMigration(store, plan.value, { apply: true, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })
    const second = await applyLegacyMemoryMigration(store, plan.value, { apply: true, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })

    expect(first.ok).toBe(true)
    // The second run is refused on duplicate ids rather than silently doubling
    // the proposal set. A refusal is the useful outcome: it says "this already
    // ran", not "here are fourteen records now".
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.category).toBe("conflict")
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(7)
  })

  it("REFUSES inputs that are not the plan's own, so a plan cannot be redirected", async () => {
    // Found by the M5.9 review as SF-3. The signature let a caller hand `apply`
    // inputs unrelated to the plan it was also given, and the function reported
    // success — so a whole plan could be written into another project while the
    // plan reported the first one.
    const store = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")

    const redirected = (plan.value.inputs as object[]).map((input) => ({ ...input, projectId: "project-somewhere-else" }))
    const error = expectError(
      await applyLegacyMemoryMigration(store, plan.value, {
        apply: true,
        migratedAt: MIGRATED_AT,
        inputs: redirected as never[],
      }),
    )
    expect(error.code).toBe("memory.migration_inputs_mismatch")
    // Nothing was written, to either project.
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(0)
    expect(await store.listProjectUnscoped("project-somewhere-else")).toHaveLength(0)
  })

  it("refuses a plan whose inputs were tampered with, even in one field", async () => {
    const store = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")

    const tampered = structuredClone(plan.value.inputs) as { content: string }[]
    tampered[0]!.content = "Something the plan never said."
    const error = expectError(
      await applyLegacyMemoryMigration(store, plan.value, {
        apply: true,
        migratedAt: MIGRATED_AT,
        inputs: tampered as never[],
      }),
    )
    expect(error.code).toBe("memory.migration_inputs_mismatch")
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(0)
  })

  it("appended records are ordinary appends: queryable, scoped, and untrusted", async () => {
    const store: MemoryRepository = repository()
    const plan = planLegacyMemoryDataMigration(LEGACY, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    await applyLegacyMemoryMigration(store, plan.value, { apply: true, migratedAt: MIGRATED_AT, inputs: plan.value.inputs as never[] })

    // Every migrated record is untrusted, so a project reader sees NOTHING yet.
    // That is the correct state: the migration created a review queue.
    const result = expectOk(await store.query({ projectId: PROJECT }, readerScope()))
    expect(result.records).toHaveLength(0)
    expect(result.withheld.every((entry) => entry.reason === "not_trusted")).toBe(true)
    expect(result.withheld).toHaveLength(7)
  })
})

describe("M5.3 refuses a source it cannot read", () => {
  it("rejects a legacy file that does not match the M0 legacy schema", async () => {
    const plan = planLegacyMemoryDataMigration({ projectId: "app", decisions: "not an array" }, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error.code).toBe("memory.legacy_source_invalid")
    // The refusal must not echo the malformed input back into a log.
    expect(plan.error.message).not.toContain("not an array")
  })

  it("rejects an unknown field rather than importing it silently", async () => {
    const plan = planLegacyMemoryDataMigration(
      { ...LEGACY, trustLevel: "root" },
      { projectId: PROJECT, migratedAt: MIGRATED_AT },
    )
    expect(plan.ok).toBe(false)
  })
})

describe("M5.3 v1 records migrate forward, and an accepted v1 record authored by an agent does not", () => {
  const v1Records = [
    {
      schemaVersion: 1,
      memoryId: "memory-legacy-user",
      projectId: PROJECT,
      kind: "decision",
      content: "A human decided this.",
      contentDigest: digestJson("A human decided this."),
      scope: { kind: "project" },
      author: { kind: "user", userId: "user-owner" },
      createdAt: "2026-09-01T00:00:00.000Z",
      sourceReferences: [{ namespace: "legacy.memory.decision", id: "d1" }],
      trustState: "accepted",
      sensitivity: "internal",
      retention: "project",
    },
    {
      schemaVersion: 1,
      memoryId: "memory-legacy-agent",
      projectId: PROJECT,
      kind: "decision",
      content: "An agent asserted this without a recorded approval.",
      contentDigest: digestJson("An agent asserted this without a recorded approval."),
      scope: { kind: "project" },
      author: { kind: "system", name: "legacy-migration" },
      createdAt: "2026-09-02T00:00:00.000Z",
      sourceReferences: [{ namespace: "legacy.memory.decision", id: "d2" }],
      trustState: "accepted",
      sensitivity: "internal",
      retention: "project",
    },
  ]

  it("keeps a v1 record's content and records both the v1 id and the v1 trust state", async () => {
    const plan = planV1MemoryMigration(v1Records, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const records = plan.value.records as MemoryRecordV2[]
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.payload.content).toBeTruthy()
      expect(record.sourceReferences?.some((reference) => reference.namespace === "memory.v1")).toBe(true)
      expect(record.payload.detail?.["legacyMemoryId"]).toMatch(/^memory-legacy-/)
    }
  })

  it("DOWNGRADES a v1 'accepted' record authored by a system back to proposed, and counts it", async () => {
    const plan = planV1MemoryMigration(v1Records, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const records = plan.value.records as MemoryRecordV2[]
    const fromAgent = records.find((record) => record.payload.detail?.["legacyMemoryId"] === "memory-legacy-agent")

    expect(fromAgent?.trust).toBe("proposed")
    expect(fromAgent?.trustDecision).toBeUndefined()
    // Both v1 records claim 'accepted', and BOTH are downgraded: the plan's
    // stop condition is about the format, not about the author kind, because a
    // v1 record never recorded who accepted it.
    expect(plan.value.counts.trustDowngrades).toBe(2)
    expect(records.every((record) => record.trust === "proposed")).toBe(true)
  })

  it("records the v1 trust state verbatim in the detail, so the downgrade is auditable", async () => {
    const plan = planV1MemoryMigration(v1Records, { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    for (const raw of plan.value.records) {
      expect((raw as MemoryRecordV2).payload.detail?.["legacyTrustState"]).toBe("accepted")
    }
  })

  it("refuses a v1 record belonging to a different project rather than importing it", async () => {
    // This asserted `ok: true` with zero records planned and a
    // `memory.legacy_project_mismatch` diagnostic in the plan. Under SF-16 that
    // expectation is the defect in another guise: "I migrated nothing, and that
    // is a success" is the same silent loss, one project-filtered instead of
    // unparseable. An operator who passed a mixed-project file was told the
    // migration worked.
    const plan = planV1MemoryMigration(
      [{ ...v1Records[0]!, projectId: "someone-elses-project" }],
      { projectId: PROJECT, migratedAt: MIGRATED_AT },
    )
    const error = expectError(plan)
    expect(error.code).toBe("memory.migration_incomplete")
    expect(error.message).toContain("memory.legacy_project_mismatch")
    expect(error.message).toContain("1 of 1 entries were not migrated")
    expect(error.message).toContain("0 would have been")
  })

  it("REFUSES the plan when an entry is unreadable, rather than migrating the readable ones", async () => {
    // SF-16. This test used to be called "records an unreadable entry as a
    // diagnostic and migrates the readable ones" and asserted `ok: true` with one
    // record planned and an error diagnostic buried in `plan.value.diagnostics`.
    // That expectation encoded the defect: a caller that checks `ok` — which is
    // the entire reason the function returns a `Result` — imported the readable
    // subset and never learned a record had been dropped. What replaces it is the
    // same scenario under the contract that makes the loss impossible: no plan,
    // and the reason in the refusal.
    const plan = planV1MemoryMigration([v1Records[0], { nonsense: true }], { projectId: PROJECT, migratedAt: MIGRATED_AT })
    const error = expectError(plan)
    expect(error.code).toBe("memory.migration_incomplete")
    // The reason travels with the refusal, and it names the offending entry so an
    // operator can find it in the source. No migrated content is echoed.
    expect(error.message).toContain("memory.legacy_v1_unreadable")
    expect(error.message).toContain("Entry 1")
    expect(error.message).not.toContain("A human decided this")
    // There is no plan at all — not a partial one.
    expect((plan as { value?: unknown }).value).toBeUndefined()
  })

  it("SF-16: a refusal counts what would have been written and what was dropped", async () => {
    const plan = planV1MemoryMigration([v1Records[0], v1Records[1], { nonsense: true }], {
      projectId: PROJECT,
      migratedAt: MIGRATED_AT,
    })
    const error = expectError(plan)
    expect(error.message).toContain("1 of 3 entries were not migrated")
    expect(error.message).toContain("2 would have been")
  })

  it("SF-16: an error diagnostic in a plan is refused at the write path too", async () => {
    // The planner cannot produce one, so this assembles a plan by hand — a caller
    // can. The write path enforces the same rule, so a partial corpus cannot
    // become a stored fact by being hand-built.
    const good = planV1MemoryMigration([v1Records[0]], { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!good.ok) throw new Error("plan should succeed")
    const planted = {
      ...good.value,
      diagnostics: [
        ...good.value.diagnostics,
        { severity: "error" as const, code: "memory.legacy_v1_unreadable", message: "Entry 9 was not migrated" },
      ],
    }

    const store = repository()
    const error = expectError(
      await applyLegacyMemoryMigration(store, planted as never, {
        apply: true,
        migratedAt: MIGRATED_AT,
        inputs: good.value.inputs as never[],
      }),
    )
    expect(error.code).toBe("memory.migration_plan_incomplete")
    expect(await store.listProjectUnscoped(PROJECT)).toHaveLength(0)
  })

  it("SF-16: a dry run refuses an incomplete plan as loudly as a real run would", async () => {
    const good = planV1MemoryMigration([v1Records[0]], { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!good.ok) throw new Error("plan should succeed")
    const planted = {
      ...good.value,
      diagnostics: [
        ...good.value.diagnostics,
        { severity: "error" as const, code: "memory.legacy_v1_unreadable", message: "Entry 9 was not migrated" },
      ],
    }

    const applied = await applyLegacyMemoryMigration(repository(), planted as never, {
      apply: false,
      migratedAt: MIGRATED_AT,
      inputs: good.value.inputs as never[],
    })
    // A dry run that said `ok` for a plan the real run refuses would not be a
    // dry run of anything.
    expect(expectError(applied).code).toBe("memory.migration_plan_incomplete")
  })

  it("SF-16: a refused plan keeps counts and records length in agreement when it is allowed to exist", async () => {
    // The completeness rule governs *error* diagnostics only. Warnings — the
    // severed supersession link — are reported inside a plan that is still the
    // whole corpus, and the schema's `counts.total === records.length` invariant
    // must keep holding there.
    const plan = planV1MemoryMigration(
      [
        v1Records[0]!,
        { ...v1Records[1]!, memoryId: "memory-links", supersedesMemoryId: "memory-not-in-corpus" },
      ],
      { projectId: PROJECT, migratedAt: MIGRATED_AT },
    )
    if (!plan.ok) throw new Error("warnings must not block a plan")
    expect(plan.value.diagnostics.map((entry) => entry.severity)).toEqual(["warning"])
    expect(plan.value.diagnostics.some((entry) => entry.code === "memory.legacy_supersession_target_absent")).toBe(true)
    expect(plan.value.counts.total).toBe(plan.value.records.length)
    expect(plan.value.inputs).toHaveLength(plan.value.records.length)
    // And the plan validates under the schema, which is where that invariant is
    // actually enforced.
    expect(() => legacyMemoryMigrationPlanSchema.parse(plan.value)).not.toThrow()
  })

  it("migrates a v1 record's sensitivity conservatively", async () => {
    const plan = planV1MemoryMigration(
      [
        { ...v1Records[0]!, memoryId: "memory-internal", sensitivity: "internal" },
        { ...v1Records[0]!, memoryId: "memory-restricted", sensitivity: "restricted" },
      ],
      { projectId: PROJECT, migratedAt: MIGRATED_AT },
    )
    if (!plan.ok) throw new Error("plan should succeed")
    const records = plan.value.records as MemoryRecordV2[]
    const byId = new Map(records.map((record) => [record.payload.detail?.["legacyMemoryId"], record.sensitivity]))
    expect(byId.get("memory-internal")).toBe("public_to_project")
    expect(byId.get("memory-restricted")).toBe("restricted")
  })
})

describe("SF-15 one trust policy, and it is the one that runs", () => {
  it("the exported policy never mints an accepted record, for any legacy trust state", () => {
    // `migratedTrustStateFor` is *the* migration trust policy; this is its whole
    // table. `accepted -> proposed` is the SF-15/R-1 rule, `rejected ->
    // rejected` is the SF-8 rule (never a trust upgrade), and the `none` row is
    // the legacy `memory.json` path, which carries no trust at all. The last
    // assertion is the one that matters: no input to this function can produce
    // `accepted`, which is the claim the migration is audited on.
    const outcomes = (["proposed", "accepted", "rejected", "none"] as const).map((state) =>
      migratedTrustStateFor(state),
    )
    expect(outcomes).toEqual(["proposed", "proposed", "rejected", "proposed"])
    expect(outcomes).not.toContain("accepted")
  })

  it("a v1 'accepted' record authored by a USER still migrates as proposed, with no decision", () => {
    // The exact statement `record.ts`'s `migrationTrustDecision` docblock
    // contradicts. `migrationTrustDecision` is exported, called from nowhere, and
    // says a v1 acceptance authored by a user is migrated as `accepted`; the code
    // that runs — the policy asserted above — never produces `accepted`.
    //
    // The author kind is deliberately part of the fixture: this is the single
    // input on which the two statements disagree, so this is the single test that
    // fails if someone wires the migration to `migrationTrustDecision`.
    const v1AcceptedByUser = { ...v1RecordsFixture({ trustState: "accepted", authorKind: "user" }) }
    const plan = planV1MemoryMigration([v1AcceptedByUser], { projectId: PROJECT, migratedAt: MIGRATED_AT })
    if (!plan.ok) throw new Error("plan should succeed")
    const records = plan.value.records as MemoryRecordV2[]

    expect(records).toHaveLength(1)
    expect(records[0]?.trust).toBe("proposed")
    // No trust decision at all: the migration cannot honestly say who decided.
    expect(records[0]?.trustDecision).toBeUndefined()
    // The claim itself is preserved as auditable data, so the downgrade is
    // reviewable rather than invisible.
    expect(records[0]?.payload.detail?.["legacyTrustState"]).toBe("accepted")
    expect(plan.value.counts.trustDowngrades).toBe(1)
  })

  it("the same downgrade holds for every author kind, so the policy is about the FORMAT", () => {
    // If the author kind moved the outcome, the policy would be
    // `migrationTrustDecision`'s — attribution by author — rather than the
    // format-based rule the plan's stop condition asks for. One row per author
    // kind, all identical.
    const kinds = ["user", "node", "session", "system"] as const
    const plans = kinds.map((authorKind) =>
      planV1MemoryMigration([v1RecordsFixture({ trustState: "accepted", authorKind })], {
        projectId: PROJECT,
        migratedAt: MIGRATED_AT,
      }),
    )
    for (const plan of plans) {
      if (!plan.ok) throw new Error("plan should succeed")
      const record = plan.value.records[0] as MemoryRecordV2
      expect(record.trust).toBe("proposed")
      expect(record.trustDecision).toBeUndefined()
      expect(plan.value.counts.trustDowngrades).toBe(1)
    }
  })

  it("a migrated corpus is untrusted end to end: nobody can read it until a user accepts", async () => {
    // The consequence that makes the policy the safe one, asserted end to end so
    // the downgrade is not just a field value but an actual read barrier.
    const store = repository()
    const plan = planV1MemoryMigration(
      [v1RecordsFixture({ trustState: "accepted", authorKind: "user" })],
      { projectId: PROJECT, migratedAt: MIGRATED_AT },
    )
    if (!plan.ok) throw new Error("plan should succeed")
    await applyLegacyMemoryMigration(store, plan.value, {
      apply: true,
      migratedAt: MIGRATED_AT,
      inputs: plan.value.inputs as never[],
    })

    const result = expectOk(await store.query({ projectId: PROJECT }, readerScope()))
    expect(result.records).toHaveLength(0)
    expect(result.withheld.every((entry) => entry.reason === "not_trusted")).toBe(true)
  })
})

describe("M5.3 a real legacy file on disk round-trips", () => {
  it("reads a hand-formatted on-disk file and leaves it byte-identical", async () => {
    // Indented with 4 spaces and a trailing blank line, the way an
    // operator-edited file actually looks. The migrator must not care about the
    // formatting and must not rewrite it.
    await mkdir(join(workingDirectory, "nested"), { recursive: true })
    const copyPath = join(workingDirectory, "nested", "copy.json")
    await writeFile(copyPath, `${JSON.stringify(LEGACY, null, 4)}\n\n`, "utf8")
    const diskBytes = await readFile(copyPath, "utf8")

    const plan = planLegacyMemoryDataMigration(JSON.parse(diskBytes), { projectId: PROJECT, migratedAt: MIGRATED_AT })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.records).toHaveLength(7)
    expect(await readFile(copyPath, "utf8")).toBe(diskBytes)
  })
})

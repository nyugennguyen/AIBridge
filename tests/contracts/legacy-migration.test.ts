import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, expectTypeOf, it } from "vitest"
import { dryRunLegacyMigration } from "../../src/orchestration/legacy/migration.js"
import {
  legacyBridgeConfigSchema,
  legacyJobRecordSchema,
  legacyMemoryDataSchema,
  legacyMigrationDryRunSchema,
} from "../../src/orchestration/legacy/schemas.js"
import type { LegacyMigrationDryRun } from "../../src/orchestration/legacy/types.js"
import type { LegacyTaskMigration } from "../../src/orchestration/legacy/types.js"
import type { TaskId } from "../../src/orchestration/identifiers.js"
import { dispatchSchema, memoryRecordSchema, runSchema, taskSchema } from "../../src/orchestration/schemas.js"

const fixtureDirectory = fileURLToPath(new URL("./fixtures/legacy/", import.meta.url))

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${fixtureDirectory}${name}`, "utf8"))
}

async function fixtures() {
  return {
    config: await readJson("config.json"),
    jobs: await readJson("jobs.json"),
    tasksMarkdown: await readFile(`${fixtureDirectory}tasks.md`, "utf8"),
    memory: await readJson("memory.json"),
  }
}

function context() {
  return {
    schemaVersion: 1,
    sourceProfileId: "profile-test-vps",
    meshId: "mesh-primary",
    importedAt: "2026-09-17T00:00:00Z",
    controllerNodeId: "node-test-vps",
    controllerEpoch: 1,
    pathResolutionBase: "/srv/apps",
    agentMappings: [
      {
        legacyAgentId: "test-vps",
        nodeId: "node-test-vps",
        installationId: "installation-opencode-test-vps",
        runtimeKind: "opencode",
      },
      {
        legacyAgentId: "dev-main",
        nodeId: "node-dev-main",
        installationId: "installation-opencode-dev-main",
        runtimeKind: "opencode",
      },
    ],
    projectMappings: [
      {
        legacyProjectId: "app",
        projectId: "project-app",
        projectPathId: "project-path-app-test-vps",
        targetNodeId: "node-test-vps",
        configuredPath: "/srv/apps/app",
      },
    ],
  }
}

describe("legacy migration contracts", () => {
  it("keeps current unversioned profile, job, and memory formats readable", async () => {
    const source = await fixtures()

    expect(legacyBridgeConfigSchema.safeParse(source.config).success).toBe(true)
    expect((source.jobs as unknown[]).every((job) => legacyJobRecordSchema.safeParse(job).success)).toBe(true)
    expect(legacyMemoryDataSchema.safeParse(source.memory).success).toBe(true)
  })

  it("maps every legacy job to one valid run, task, and dispatch with external correlation", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())

    expect(plan.canCommit).toBe(true)
    expect(plan.jobs).toHaveLength(3)
    expect(new Set(plan.jobs.map((job) => job.run.runId))).toHaveLength(3)
    expect(new Set(plan.jobs.map((job) => job.task.taskId))).toHaveLength(3)
    expect(new Set(plan.jobs.map((job) => job.dispatch.envelope.dispatchId))).toHaveLength(3)

    for (const job of plan.jobs) {
      expect(runSchema.safeParse(job.run).success).toBe(true)
      expect(taskSchema.safeParse(job.task).success).toBe(true)
      expect(dispatchSchema.safeParse(job.dispatch).success).toBe(true)
      expect(job.run.externalReferences[0]).toEqual({ namespace: "legacy.job", id: job.legacyRecord.id })
      expect(job.run.runId).not.toBe(job.run.externalReferences[0]?.id)
      expect(job.task.taskId).not.toBe(job.run.externalReferences[0]?.id)
      expect(job.dispatch.envelope.dispatchId).not.toBe(job.run.externalReferences[0]?.id)
      expect(job.executionPolicy).toBe("inert")
      expect(job.authorization.bearerAuthentication).toBe("required_not_persisted")
      expect(job.legacyRecord.id).toBe(job.run.externalReferences[0]?.id)
    }
  })

  it("preserves authorization and exact project allowlisting without importing bearer material", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())

    expect(plan.configuration?.authentication).toEqual({
      mode: "bearer-token",
      disposition: "compatibility_only",
      tokenMaterial: "not_imported",
    })
    expect(plan.configuration?.legacyRecord).toEqual((await fixtures()).config)
    expect(plan.configuration?.allowedSources).toEqual([
      {
        source_agent_id: "dev-main",
        capabilities: ["testing", "deployment"],
        requires_plan_approval: ["deployment"],
      },
    ])
    expect(plan.configuration?.projects[0]).toMatchObject({
      configuredPath: "/srv/apps/app",
      resolvedPath: "/srv/apps/app",
      capabilities: ["testing", "deployment"],
      canonicalProjectId: "project-app",
      canonicalProjectPathId: "project-path-app-test-vps",
    })
    expect(plan.jobs.every((job) => job.authorization.historicalChecksPass)).toBe(true)
    expect(JSON.stringify(plan)).not.toContain("OPENCODE_SERVER_PASSWORD=")
  })

  it("pauses active work, preserves terminal outcomes, and keeps callback delivery separate", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())
    const completed = plan.jobs.find((job) => job.legacyRecord.id === "job-completed")!
    const running = plan.jobs.find((job) => job.legacyRecord.id === "job-running")!
    const callbackFailed = plan.jobs.find((job) => job.legacyRecord.id === "job-callback-failed")!

    expect(completed.disposition).toBe("historical")
    expect(completed.run.state).toBe("completed")
    expect(completed.task.state).toBe("completed")
    expect(completed.dispatch.state).toBe("completed")
    expect(completed.callbackDelivery?.status).toBe("failed")

    expect(running.disposition).toBe("paused")
    expect(running.executionPolicy).toBe("inert")
    // Non-terminal migrated work stays paused rather than being auto-resumed;
    // `paused` is a run-level gate, not a lifecycle state.
    expect(running.run.state).toBe("active")
    expect(running.run.paused).toBe(true)
    expect(running.task.state).toBe("running")
    expect(running.dispatch.state).toBe("running")
    expect(running.providerSessionReference).toEqual({ namespace: "opencode.session", id: "ses-running" })
    expect(running.authorization.canonicalApprovalCreated).toBe(false)
    expect(running.legacyRecord.trigger.metadata?.approved_by).toBe("legacy-operator")

    expect(callbackFailed.run.state).toBe("active")
    expect(callbackFailed.run.paused).toBe(true)
    // A legacy blocked job never ran and is not dependency-gated, so its honest
    // lifecycle is `pending`; the run stays paused and requires reconciliation.
    expect(callbackFailed.task.state).toBe("pending")
    expect(callbackFailed.dispatch.state).toBe("proposed")
    expect(callbackFailed.callbackDelivery?.status).toBe("failed")
    expect(plan.diagnostics.some((entry) => entry.code === "status.callback_outcome_ambiguous")).toBe(true)
  })

  it("preserves all legacy dependencies as compatibility references without cross-Run Task edges", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())
    const running = plan.jobs.find((job) => job.legacyRecord.id === "job-running")!

    expect(running.task.runId).not.toBe(plan.jobs.find((job) => job.legacyRecord.id === "job-completed")!.task.runId)
    expect(running.task.dependencies).toEqual([])
    expect(running.dispatch.envelope.dependencies).toEqual([])
    expect(running.localDependencyReferences).toEqual([{ namespace: "legacy.job", id: "job-completed" }])
    expect(running.remoteDependencyReferences).toEqual([
      {
        namespace: "legacy.remote-job",
        id: "audit-vps/remote-audit",
        status: "completed",
        reportedAt: "2026-09-16T00:09:30Z",
      },
    ])
    expect(plan.tasks.find((task) => task.reference.id === "#2")?.legacyRecord.depends_on).toEqual(["#1"])
    expect(plan.diagnostics.some((entry) => entry.code === "dependency.local_cross_run_reference")).toBe(true)
  })

  it("imports memory as proposed evidence with unverified legacy labels", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())

    expect(plan.memory).toHaveLength(3)
    expect(plan.memory.every((record) => memoryRecordSchema.safeParse(record).success)).toBe(true)
    expect(plan.memory.every((record) => record.trustState === "proposed")).toBe(true)
    expect(plan.memory[0]?.author).toEqual({ kind: "system", name: "legacy-migration" })
    expect(plan.memory[0]?.sourceReferences).toContainEqual({ namespace: "legacy.agent-label", id: "dev-main" })
  })

  it("is deterministic and changes the source digest without remapping identities", async () => {
    const source = await fixtures()
    const first = dryRunLegacyMigration(source, context())
    const retry = dryRunLegacyMigration(structuredClone(source), context())
    expect(retry).toEqual(first)

    const changed = structuredClone(source) as { jobs: Array<{ id: string; trigger: { prompt: string } }> }
    changed.jobs[0]!.trigger.prompt = "Run a changed test suite."
    const conflictCandidate = dryRunLegacyMigration(changed, context())
    expect(conflictCandidate.sourceDigest).not.toBe(first.sourceDigest)
    expect(conflictCandidate.jobs[0]?.sourceDigest).not.toBe(first.jobs[0]?.sourceDigest)
    expect(conflictCandidate.jobs[0]?.importKey).toBe(first.jobs[0]?.importKey)
    expect(conflictCandidate.jobs[0]?.run.runId).toBe(first.jobs[0]?.run.runId)
    expect(conflictCandidate.jobs[0]?.task.taskId).toBe(first.jobs[0]?.task.taskId)
    expect(conflictCandidate.jobs[0]?.dispatch.envelope.dispatchId).toBe(first.jobs[0]?.dispatch.envelope.dispatchId)
  })

  it("scopes identities to the stable source profile/node/project and fingerprints material mappings", async () => {
    const source = await fixtures()
    const firstContext = context()
    const first = dryRunLegacyMigration(source, firstContext)

    const laterContext = structuredClone(firstContext)
    laterContext.importedAt = "2026-09-18T00:00:00Z"
    const later = dryRunLegacyMigration(source, laterContext)
    expect(later.mappingFingerprint).toBe(first.mappingFingerprint)
    expect(later.jobs.map((job) => job.importKey)).toEqual(first.jobs.map((job) => job.importKey))
    expect(later.jobs.map((job) => job.run.runId)).toEqual(first.jobs.map((job) => job.run.runId))
    expect(later.memory.map((memory) => memory.memoryId)).toEqual(first.memory.map((memory) => memory.memoryId))

    const remappedContext = structuredClone(firstContext)
    remappedContext.agentMappings[0]!.installationId = "installation-opencode-test-vps-v2"
    const remapped = dryRunLegacyMigration(source, remappedContext)
    expect(remapped.mappingFingerprint).not.toBe(first.mappingFingerprint)
    expect(remapped.jobs.map((job) => job.importKey)).toEqual(first.jobs.map((job) => job.importKey))
    expect(remapped.jobs.map((job) => job.run.runId)).toEqual(first.jobs.map((job) => job.run.runId))

    const otherProfileContext = structuredClone(firstContext)
    otherProfileContext.sourceProfileId = "profile-test-vps-restored-copy"
    const otherProfile = dryRunLegacyMigration(source, otherProfileContext)
    expect(otherProfile.jobs[0]?.importKey).not.toBe(first.jobs[0]?.importKey)
    expect(otherProfile.jobs[0]?.run.runId).not.toBe(first.jobs[0]?.run.runId)

    const otherProjectSource = structuredClone(source) as {
      config: { projects: Array<{ id: string; path: string; capabilities: string[] }> }
      jobs: Array<{ trigger: { project_dir: string } }>
    }
    otherProjectSource.config.projects.push({ id: "app-copy", path: "/srv/apps/app-copy", capabilities: ["testing"] })
    otherProjectSource.jobs[0]!.trigger.project_dir = "/srv/apps/app-copy"
    const otherProjectContext = structuredClone(firstContext)
    otherProjectContext.projectMappings.push({
      legacyProjectId: "app-copy",
      projectId: "project-app-copy",
      projectPathId: "project-path-app-copy-test-vps",
      targetNodeId: "node-test-vps",
      configuredPath: "/srv/apps/app-copy",
    })
    const otherProject = dryRunLegacyMigration(otherProjectSource, otherProjectContext)
    expect(otherProject.canCommit).toBe(true)
    expect(otherProject.jobs[0]?.importKey).not.toBe(first.jobs[0]?.importKey)
    expect(otherProject.jobs[0]?.run.runId).not.toBe(first.jobs[0]?.run.runId)
  })

  it("rejects credential-bearing URLs without echoing their contents", async () => {
    const callbackCredentials = await fixtures() as { jobs: Array<{ trigger: { callback_url: string } }> }
    callbackCredentials.jobs[0]!.trigger.callback_url = "https://callback-user:do-not-echo@example.test/report"
    const callbackPlan = dryRunLegacyMigration(callbackCredentials, context())
    expect(callbackPlan.canCommit).toBe(false)
    expect(callbackPlan.diagnostics.some((entry) => entry.code === "security.credential_url")).toBe(true)
    expect(JSON.stringify(callbackPlan.diagnostics)).not.toContain("do-not-echo")
    expect(JSON.stringify(callbackPlan.diagnostics)).not.toContain("callback-user")

    const configCredentials = await fixtures() as { config: { opencode: { base_url: string }; agents: Array<{ url: string }> } }
    configCredentials.config.opencode.base_url = "https://runtime-user:runtime-secret@example.test"
    configCredentials.config.agents[0]!.url = "https://example.test/bridge?api_key=agent-secret"
    const configPlan = dryRunLegacyMigration(configCredentials, context())
    expect(configPlan.canCommit).toBe(false)
    expect(configPlan.diagnostics.filter((entry) => entry.code === "security.credential_url")).toHaveLength(2)
    expect(JSON.stringify(configPlan.diagnostics)).not.toContain("runtime-secret")
    expect(JSON.stringify(configPlan.diagnostics)).not.toContain("agent-secret")
  })

  it("returns diagnostics instead of throwing for denied paths, unknown targets, self-dependencies, and bounds", async () => {
    const deniedPath = await fixtures() as { jobs: Array<{ trigger: { project_dir: string } }> }
    deniedPath.jobs[0]!.trigger.project_dir = "/srv/not-allowed"
    expect(() => dryRunLegacyMigration(deniedPath, context())).not.toThrow()
    const deniedPathPlan = dryRunLegacyMigration(deniedPath, context())
    expect(deniedPathPlan.canCommit).toBe(false)
    expect(deniedPathPlan.diagnostics.some((entry) => entry.code === "authorization.project_path_denied")).toBe(true)

    const unknownTarget = await fixtures() as { jobs: Array<{ trigger: { target_agent_id: string } }> }
    unknownTarget.jobs[0]!.trigger.target_agent_id = "unknown-target"
    expect(() => dryRunLegacyMigration(unknownTarget, context())).not.toThrow()
    const unknownTargetPlan = dryRunLegacyMigration(unknownTarget, context())
    expect(unknownTargetPlan.canCommit).toBe(false)
    expect(unknownTargetPlan.diagnostics.some((entry) => entry.code === "mapping.job_target_missing")).toBe(true)

    const selfDependency = await fixtures() as { jobs: Array<{ id: string; trigger: { depends_on: unknown[] } }> }
    selfDependency.jobs[0]!.trigger.depends_on = [selfDependency.jobs[0]!.id]
    expect(() => dryRunLegacyMigration(selfDependency, context())).not.toThrow()
    const selfDependencyPlan = dryRunLegacyMigration(selfDependency, context())
    expect(selfDependencyPlan.canCommit).toBe(false)
    expect(selfDependencyPlan.diagnostics.some((entry) => entry.code === "dependency.self_reference")).toBe(true)

    const outOfBounds = await fixtures() as { jobs: Array<{ trigger: { prompt: string } }> }
    outOfBounds.jobs[0]!.trigger.prompt = "x".repeat(65_537)
    expect(() => dryRunLegacyMigration(outOfBounds, context())).not.toThrow()
    const boundsPlan = dryRunLegacyMigration(outOfBounds, context())
    expect(boundsPlan.canCommit).toBe(false)
    expect(boundsPlan.diagnostics.some((entry) => entry.code === "source.invalid")).toBe(true)

    const canonicalMismatch = await fixtures() as {
      jobs: Array<{ id: string; trigger: { job_id?: string } }>
      tasksMarkdown: string
    }
    canonicalMismatch.jobs = [canonicalMismatch.jobs[0]!]
    canonicalMismatch.jobs[0]!.id = "job "
    canonicalMismatch.jobs[0]!.trigger.job_id = "job "
    canonicalMismatch.tasksMarkdown = ""
    expect(() => dryRunLegacyMigration(canonicalMismatch, context())).not.toThrow()
    const mismatchPlan = dryRunLegacyMigration(canonicalMismatch, context())
    expect(mismatchPlan.canCommit).toBe(false)
    expect(mismatchPlan.jobs).toEqual([])
    expect(mismatchPlan.diagnostics).toContainEqual({
      severity: "error",
      code: "conversion.canonical_validation_failed",
      message: "Legacy input cannot be represented by the canonical version-one contracts.",
    })
  })

  it("fails closed for unauthorized, corrupt, unsupported, or incompletely mapped input", async () => {
    const unauthorized = await fixtures() as { jobs: Array<{ trigger: { source_agent_id: string } }> }
    unauthorized.jobs[0]!.trigger.source_agent_id = "intruder"
    const unauthorizedPlan = dryRunLegacyMigration(unauthorized, context())
    expect(unauthorizedPlan.canCommit).toBe(false)
    expect(unauthorizedPlan.jobs[0]?.disposition).toBe("rejected")
    expect(unauthorizedPlan.diagnostics.some((entry) => entry.code === "authorization.source_capability_denied")).toBe(true)

    const corrupt = await fixtures() as { jobs: Array<{ status: string }> }
    corrupt.jobs[0]!.status = "mystery"
    const corruptPlan = dryRunLegacyMigration(corrupt, context())
    expect(corruptPlan.canCommit).toBe(false)
    expect(corruptPlan.jobs).toEqual([])
    expect(corruptPlan.diagnostics.some((entry) => entry.code === "source.invalid")).toBe(true)

    const unsupported = await fixtures() as { config: { security: { auth_mode: string } } }
    unsupported.config.security.auth_mode = "none"
    expect(dryRunLegacyMigration(unsupported, context()).canCommit).toBe(false)

    const missingMapping = context()
    missingMapping.projectMappings = []
    const missingMappingPlan = dryRunLegacyMigration(await fixtures(), missingMapping)
    expect(missingMappingPlan.canCommit).toBe(false)
    expect(missingMappingPlan.diagnostics.some((entry) => entry.code === "mapping.project_missing")).toBe(true)
  })

  it("exports an inferred, versioned dry-run result type", async () => {
    const plan = dryRunLegacyMigration(await fixtures(), context())
    expect(legacyMigrationDryRunSchema.safeParse(plan).success).toBe(true)
    expectTypeOf(plan).toEqualTypeOf<LegacyMigrationDryRun>()
    expectTypeOf<NonNullable<LegacyTaskMigration["canonicalTaskId"]>>().toEqualTypeOf<TaskId>()
  })
})

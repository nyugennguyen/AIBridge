import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildTestApp, InMemoryJobStore, validTrigger } from "./fixtures.js"
import { JobManager } from "../../src/jobs/manager.js"
import { digestJson } from "../../src/orchestration/digest.js"
import { correlationIdSchema, installationIdSchema, nodeIdSchema, timestampSchema } from "../../src/orchestration/identifiers.js"
import {
  LegacyTranslation,
  legacyCorrelationIdFor,
  legacyRunCreateCommand,
  legacyTranslationContextSchema,
  translateLegacyJob,
  type LegacyCorrelation,
  type LegacyTranslationContext,
} from "../../src/orchestration/legacy/translation.js"
import type { OrchestrationCommand } from "../../src/orchestration/types.js"

const NOW = timestampSchema.parse("2026-09-28T00:00:00.000Z")
const LATER = timestampSchema.parse("2026-09-28T06:00:00.000Z")

/**
 * A recording command sink standing in for `DispatchCoordinator`.
 *
 * Deliberately minimal: the legacy layer depends only on the command seam, so
 * these tests prove the compatibility policy without standing up a database.
 * Duplicate detection is keyed on `commandId` exactly as the real store's
 * semantic fingerprint is, which is what makes a retried trigger converge.
 */
class RecordingCommands {
  readonly submitted: OrchestrationCommand[] = []
  readonly #seen = new Set<string>()

  submit(command: OrchestrationCommand) {
    this.submitted.push(command)
    const key = `${command.projectId}/${command.runId}/${command.commandId}`
    if (this.#seen.has(key)) return { ok: true as const, value: { events: [] as readonly string[], duplicate: true } }
    this.#seen.add(key)
    return { ok: true as const, value: { events: [command.type] as readonly string[], duplicate: false } }
  }
}

function context(overrides: Partial<LegacyTranslationContext> = {}): LegacyTranslationContext {
  return legacyTranslationContextSchema.parse({
    schemaVersion: 1,
    sourceProfileId: "profile-test-vps",
    controllerNodeId: "node-test-vps",
    controllerEpoch: 1,
    leaseId: "lease-test-vps",
    pathResolutionBase: "/srv/apps",
    localAgentId: "test-vps",
    agentMappings: [
      {
        legacyAgentId: "test-vps",
        nodeId: "node-test-vps",
        installationId: "installation-opencode-test-vps",
        runtimeKind: "opencode",
      },
      // The offline import requires EVERY allowed source to be mapped, not just
      // the local node, so the shared context carries both and the two paths
      // are provably driven by the same mapping.
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
    ...overrides,
  })
}

/** A legacy job record shaped exactly as the JSON store holds one. */
function legacyJob(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "job_1",
    trigger: validTrigger(),
    status: "running",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:01.000Z",
    ...overrides,
  }
}

function kernelApp(now: () => typeof NOW = () => NOW) {
  const commands = new RecordingCommands()
  const translation = new LegacyTranslation({ mode: "present", context: context(), now, commands })
  return { commands, translation }
}

function expectOk(result: ReturnType<typeof translateLegacyJob>) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result
}

/**
 * The names the legacy module exports, as a plain record.
 *
 * Deliberately not a typed import: the point is to assert that names are GONE,
 * and a typed import of a name that no longer exists would not compile, so the
 * test could never be the thing that proves the retirement. The copy is made
 * because the assertion is about the module's export surface, and a live module
 * namespace is a view the test runner is free to hand back in any shape it
 * likes.
 */
async function legacyModuleExports(): Promise<Record<string, unknown>> {
  const namespace = await import("../../src/orchestration/legacy/translation.js")
  return Object.fromEntries(Object.keys(namespace).map((key) => [key, (namespace as Record<string, unknown>)[key]]))
}

/**
 * The comment-stripped source of a file, line by line.
 *
 * The comments in this layer must keep naming what was retired and why — that
 * record is the whole reason the decision is auditable — so scanning raw text
 * would either fail on the explanation or force the explanation to be deleted.
 * Filtering by line shape rather than by a comment regex is deliberate: a regex
 * scanner has to know where a string literal ends, and a comment-closing token
 * inside one turns it into a parser that is confidently wrong. This filter cannot
 * be confused by content, and it fails closed on a trailing comment.
 */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")
}

/**
 * Every source file the legacy layer consists of, plus the routes that drive it.
 *
 * The routes are included because "no legacy path may name a runtime effect" is a
 * statement about reachability, not about which directory a string lives in.
 */
function legacySourceFiles(): string[] {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const legacyDir = join(root, "src/orchestration/legacy")
  return [
    ...readdirSync(legacyDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(legacyDir, name)),
    join(root, "src/server/routes/trigger.ts"),
    join(root, "src/server/routes/report.ts"),
    join(root, "src/server/routes/jobs.ts"),
  ]
}

describe("A legacy job maps to a canonical run, task, and dispatch", () => {
  it("derives explicit provenance, not an inferred link", () => {
    const { correlation, run, task, dispatch } = expectOk(translateLegacyJob(legacyJob(), context()))

    // The reference is what makes the mapping auditable: the derived ids are
    // content hashes and say nothing about which legacy job produced them.
    expect(correlation.reference).toEqual({ namespace: "legacy.job", id: "job_1" })
    expect(correlation.legacyJobId).toBe("job_1")
    expect(run.externalReferences).toEqual([correlation.reference])
    expect(task.externalReferences).toEqual([correlation.reference])
    expect(dispatch.externalReferences).toEqual([correlation.reference])

    // And it is stored on the aggregate itself, so a reader of the run — not
    // only of this adapter — can see where it came from.
    expect(correlation.dispatchId).toBe(dispatch.envelope.dispatchId)
    expect(correlation.taskId).toBe(task.taskId)
    expect(correlation.runId).toBe(run.runId)
    expect(correlation.projectId).toBe(run.projectId)
    expect(run.runId).not.toBe(correlation.legacyJobId)
  })

  it("keeps the run inert: legacy work has no canonical approval, so no run is active", () => {
    const { run, task, dispatch } = expectOk(translateLegacyJob(legacyJob(), context()))

    // The plan makes a run active only after its first APPROVED dispatch. A
    // legacy trigger has none, so claiming `active` would fabricate one.
    expect(run.state).toBe("draft")
    expect(run.paused).toBe(true)
    expect(task.state).toBe("pending")
    expect(dispatch.state).toBe("proposed")
    // The envelope still DEMANDS a fresh approval before it may start.
    expect(dispatch.envelope.permissionEnvelope.approvalRequirements.capabilities).toEqual(["testing"])
  })

  it("preserves a terminal legacy outcome, because an outcome is a fact", () => {
    const completed = expectOk(translateLegacyJob(legacyJob({ status: "completed" }), context()))
    expect(completed.task.state).toBe("completed")
    const failed = expectOk(translateLegacyJob(legacyJob({ status: "failed" }), context()))
    expect(failed.task.state).toBe("failed")
  })
})

describe("The mapping is deterministic", () => {
  it("produces identical canonical records and a stable digest for identical input", () => {
    const first = expectOk(translateLegacyJob(legacyJob(), context()))
    const second = expectOk(translateLegacyJob(legacyJob(), context()))

    expect(second.run).toEqual(first.run)
    expect(second.task).toEqual(first.task)
    expect(second.dispatch).toEqual(first.dispatch)
    expect(second.correlation).toEqual(first.correlation)
    expect(second.correlation.mappingDigest).toBe(first.correlation.mappingDigest)
    expect(second.correlation.envelopeDigest).toBe(first.correlation.envelopeDigest)
  })

  it("derives no timestamp from the wall clock", () => {
    // Every timestamp on the canonical records comes from the legacy record
    // itself. A clock reading here would change the envelope digest on every
    // run, and an approval binds to that digest.
    const { run, task, dispatch } = expectOk(translateLegacyJob(legacyJob(), context()))
    expect(run.createdAt).toBe("2026-09-28T00:00:00.000Z")
    expect(run.updatedAt).toBe("2026-09-28T00:00:01.000Z")
    expect(dispatch.createdAt).toBe("2026-09-28T00:00:00.000Z")
    expect(task.taskId).toBe(dispatch.envelope.taskId)
  })

  it("scopes identity to the source profile, so a restored copy cannot collide", () => {
    const first = expectOk(translateLegacyJob(legacyJob(), context()))
    const otherProfile = expectOk(
      translateLegacyJob(legacyJob(), context({ sourceProfileId: "profile-test-vps-restored-copy" })),
    )
    expect(otherProfile.correlation.runId).not.toBe(first.correlation.runId)
    expect(otherProfile.correlation.mappingDigest).not.toBe(first.correlation.mappingDigest)

    // A remapped installation changes the material mapping, so the mapping
    // fingerprint of the source changes even though the job identity does not.
    const remapped = context({
      agentMappings: [
        { ...context().agentMappings[0]!, installationId: installationIdSchema.parse("installation-opencode-test-vps-v2") },
        ...context().agentMappings.slice(1),
      ],
    })
    const remappedResult = expectOk(translateLegacyJob(legacyJob(), remapped))
    expect(remappedResult.correlation.runId).toBe(first.correlation.runId)
    expect(remappedResult.dispatch.envelope.installationId).toBe("installation-opencode-test-vps-v2")
  })

  it("builds a command whose identity is derived, so a retry is a duplicate", () => {
    const mapping = expectOk(translateLegacyJob(legacyJob(), context()))
    const actor = { kind: "node" as const, nodeId: nodeIdSchema.parse("node-test-vps") }
    const first = legacyRunCreateCommand(mapping, {
      now: NOW,
      actor,
      context: context(),
      correlationId: legacyCorrelationIdFor(mapping),
    })
    const retryUnderAnotherClock = legacyRunCreateCommand(mapping, {
      now: LATER,
      actor,
      context: context(),
      correlationId: legacyCorrelationIdFor(mapping),
    })

    // The command id comes from the canonical run, never from the clock, so a
    // retried `/trigger` is recognised rather than creating a second run.
    expect(retryUnderAnotherClock.commandId).toBe(first.commandId)
    expect(retryUnderAnotherClock.issuedAt).toBe(LATER)
    expect(first.payload).toMatchObject({ run: { runId: mapping.correlation.runId } })
    // The correlation id is derived from the legacy job too, so the causal
    // chain of a replay is the same chain.
    expect(legacyCorrelationIdFor(mapping)).toBe(correlationIdSchema.parse("legacy-job_1"))
  })
})

describe("Compatibility policy: kernel absent", () => {
  it("serves the identical contract and writes nothing to the kernel", async () => {
    const { app, opencode } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, job_id: "job_1", opencode_session_id: "ses_1" })
    expect(opencode.createdSessions).toBe(1)
  })

  it("answers /jobs/:id with the bare legacy record, adding no field", async () => {
    const { app, jobManager } = await buildTestApp()
    await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })

    const response = await app.inject({ method: "GET", url: "/jobs/job_1" })

    // Byte-identical to the stored record: the absent-kernel response adds
    // nothing, so a client that predates the kernel sees no change at all.
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(await jobManager.getJob("job_1"))))
    expect(response.json().orchestration).toBeUndefined()
  })
})

describe("Compatibility policy: kernel present", () => {
  it("serves the identical contract while recording the intent first", async () => {
    const { translation, commands } = kernelApp()
    const { app, opencode } = await buildTestApp({ orchestration: { translation } })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    // Byte-identical to the kernel-absent response.
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, job_id: "job_1", target_agent_id: "test-vps", status: "accepted", opencode_session_id: "ses_1" })
    expect(response.json().status_url).toBe("http://test-vps.tailnet:8787/jobs/job_1")
    // And the intent is on record, as one `run.create` command.
    expect(commands.submitted).toHaveLength(1)
    expect(commands.submitted[0]?.type).toBe("run.create")
    expect(opencode.createdSessions).toBe(1)
    expect(opencode.sentPrompts).toBe(1)
  })

  it("records the intent and names NO launch effect, so the legacy path cannot reach a runtime", async () => {
    // M4-A / F-05. This used to assert the opposite: that a
    // `legacy.runtime.launch` outbox record was minted and acknowledged once the
    // runtime accepted. The retirement is not a weakening of the contract — the
    // HTTP response below is byte-for-byte what it always was, and the session is
    // still created — but the kernel no longer VOUCHES for that session, and
    // vouching was the finding.
    const { translation, commands } = kernelApp()
    const { app, opencode } = await buildTestApp({ orchestration: { translation } })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    // Byte-identical to the kernel-absent response: retiring the launch effect
    // changed no field, no status code and no header.
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      accepted: true,
      job_id: "job_1",
      target_agent_id: "test-vps",
      status: "accepted",
      opencode_session_id: "ses_1",
    })
    expect(Object.keys(response.json()).sort()).toEqual(
      ["accepted", "job_id", "opencode_session_id", "status", "status_url", "target_agent_id"].sort(),
    )
    // The released legacy launch still happens...
    expect(opencode.createdSessions).toBe(1)
    expect(opencode.sentPrompts).toBe(1)
    // ...and the kernel recorded exactly one `run.create` and nothing else.
    expect(commands.submitted).toHaveLength(1)
    expect(commands.submitted[0]?.type).toBe("run.create")
    expect(commands.submitted.flatMap((command) => (command.type === "run.create" ? [] : [command.type]))).toEqual([])
  })

  it("adds the correlation to /jobs/:id without changing any legacy field", async () => {
    const { translation } = kernelApp()
    const { app, jobManager } = await buildTestApp({ orchestration: { translation } })
    await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })

    const response = await app.inject({ method: "GET", url: "/jobs/job_1" })
    const body = response.json()
    const stored = await jobManager.getJob("job_1")

    expect(response.statusCode).toBe(200)
    // Every legacy field is preserved exactly; the kernel only ADDS.
    expect(body.id).toBe(stored.id)
    expect(body.status).toBe(stored.status)
    expect(body.trigger).toEqual(stored.trigger)
    expect(body.orchestration.correlation.legacyJobId).toBe("job_1")
    expect(body.orchestration.correlation.reference).toEqual({ namespace: "legacy.job", id: "job_1" })
    expect(body.orchestration.correlation.mappingDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("answers /jobs/:id for a legacy job written before the kernel was attached", async () => {
    // Correlation is DERIVED from the stored record, not read from a side
    // table, so a job that predates the kernel still resolves.
    const jobManager = new JobManager(new InMemoryJobStore())
    await jobManager.createJob(validTrigger(), "2026-09-28T00:00:00.000Z")
    await jobManager.markRunning("job_1", "2026-09-28T00:00:01.000Z")
    const { translation } = kernelApp()
    const { app } = await buildTestApp({ jobManager, orchestration: { translation } })

    const response = await app.inject({ method: "GET", url: "/jobs/job_1" })

    expect(response.statusCode).toBe(200)
    expect(response.json().orchestration.correlation.legacyJobId).toBe("job_1")
  })

  it("returns the same correlation for the same job across independent processes", async () => {
    const first = expectOk(translateLegacyJob(legacyJob(), context())).correlation
    const restarted = expectOk(translateLegacyJob(legacyJob(), context())).correlation
    expect(restarted).toEqual(first)
  })

  it("still serves a duplicate trigger as 409 without a second canonical run", async () => {
    const { translation, commands } = kernelApp()
    const { app } = await buildTestApp({ orchestration: { translation } })
    const request = { method: "POST" as const, url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() }

    expect((await app.inject(request)).statusCode).toBe(202)
    expect((await app.inject(request)).statusCode).toBe(409)
    expect(commands.submitted).toHaveLength(1)
  })

  it("records a blocked trigger with no launch effect, so it cannot reach a runtime", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dependency = await jobManager.createJob(validTrigger({ job_id: "dep_1" }))
    const { translation, commands } = kernelApp()
    const { app, opencode } = await buildTestApp({ jobManager, orchestration: { translation } })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: { ...validTrigger({ job_id: "job_2" }), depends_on: [dependency.id] },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json().status).toBe("blocked")
    expect(response.json().opencode_session_id).toBeUndefined()
    expect(opencode.createdSessions).toBe(0)
    // The intent IS recorded: a blocked job is accepted work.
    expect(commands.submitted).toHaveLength(1)
    expect((await jobManager.getJob("job_2")).status).toBe("blocked")
  })

  it("correlates a /report without fabricating a lifecycle event", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const blocked = await jobManager.createJob({
      job_id: "job_waiting",
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "Run tests.",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
      depends_on: [{ agent_id: "dev-main", job_id: "job_1" }],
    })
    await jobManager.markBlocked(blocked.id, blocked.trigger.depends_on ?? [])
    const { translation, commands } = kernelApp()
    const { app, opencode } = await buildTestApp({ jobManager, orchestration: { translation } })

    const response = await app.inject({
      method: "POST",
      url: "/report",
      headers: { authorization: "Bearer secret" },
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        opencode_session_id: "ses_1",
        status: "completed",
        summary: "Testing completed.",
        findings: [],
        artifacts: [],
        started_at: "2026-06-15T00:00:00.000Z",
        completed_at: "2026-06-15T00:01:00.000Z",
      },
    })

    // A report is an OBSERVATION. It unblocks the legacy read model exactly as
    // before, and submits no canonical command: a report must not be able to
    // authorize anything.
    expect(response.statusCode).toBe(202)
    expect((await jobManager.getJob(blocked.id)).status).toBe("running")
    expect(commands.submitted).toHaveLength(0)
    expect(opencode.createdSessions).toBe(1)
  })
})

describe("Compatibility policy: unrepresentable and malformed records fail closed", () => {
  it("refuses a job whose target has no explicit mapping", () => {
    const result = translateLegacyJob(legacyJob({ trigger: validTrigger({ target_agent_id: "unknown-agent" }) }), context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("legacy.target_unmapped")
    expect(result.error.disposition).toBe("unrepresentable")
  })

  it("refuses a job whose project path is not an exact canonical match", () => {
    const result = translateLegacyJob(legacyJob({ trigger: validTrigger({ project_dir: "/srv/not-allowed" }) }), context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("legacy.project_unmapped")
  })

  it("refuses a malformed record rather than guessing its meaning", () => {
    const result = translateLegacyJob({ id: "job_1", status: "mystery" }, context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("legacy.malformed_record")
    expect(result.error.disposition).toBe("malformed")
    expect(result.error.diagnostics.length).toBeGreaterThan(0)
  })

  it("does not tell the caller a job started when the kernel cannot account for it", async () => {
    const unmapped = context()
    unmapped.projectMappings = []
    const { translation, commands } = kernelApp()
    // A context with no project mapping cannot represent the job.
    const broken = new LegacyTranslation({ mode: "present", context: unmapped, now: () => NOW, commands })
    void translation
    const { app, opencode, jobManager } = await buildTestApp({ orchestration: { translation: broken } })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    // Not 202: a 202 would assert the work was accepted for execution.
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: "legacy.project_unmapped" })
    expect(opencode.createdSessions).toBe(0)
    // The job is not silently dropped either: it exists with a diagnosable error.
    const job = await jobManager.getJob("job_1")
    expect(job.status).toBe("failed")
    expect(job.error).toContain("no exact canonical project mapping")
  })

  it("reports an unrepresentable stored job as diagnosable, not as 'not found'", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    await jobManager.createJob(validTrigger(), "2026-09-28T00:00:00.000Z")
    const { translation } = kernelApp()
    const unmapped = context()
    unmapped.projectMappings = []
    const { app } = await buildTestApp({
      jobManager,
      orchestration: { translation: new LegacyTranslation({ mode: "present", context: unmapped, now: () => NOW, commands: new RecordingCommands() }) },
    })

    const response = await app.inject({ method: "GET", url: "/jobs/job_1" })

    // The record EXISTS; only the mapping is missing. A 404 here would hide a
    // real data problem behind a plausible-looking one.
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: "legacy.project_unmapped" })
    void translation
  })
})

describe("M4-A / F-05: the legacy launch path is retired", () => {
  // F-05 was: `legacy.runtime.launch` reached a runtime with no canonical,
  // recorded, digest-bound approval. The launch intent was digest-bound and
  // tamper-checked, which is INTEGRITY — it proves nobody edited the payload.
  // It was not AUTHENTICITY, and a route's bearer token plus source/capability
  // pair plus allowlist entry plus legacy plan annotation is not an approval.
  //
  // The alternative was minting a canonical `approval.decided` for legacy work.
  // That was rejected: it would make the route's checks INTO the approval, and
  // put a non-canonical grant inside the very digest chain the approval
  // invariant protects. So the path is retired instead, and the tests below
  // exist to make that irreversible-by-accident: a compatibility receipt must
  // never be able to grow back into a runtime destination.

  it("has no launch machinery left to reach, in the module surface...", async () => {
    const legacy = await legacyModuleExports()
    for (const retired of [
      "LEGACY_LAUNCH_DESTINATION",
      "legacyLaunchIntent",
      "legacyLaunchIntentSchema",
      "legacyLaunchAuthorizationSchema",
      "LegacyLaunchOutbox",
      "verifyLegacyLaunchIntent",
    ]) {
      expect(legacy[retired]).toBeUndefined()
    }
    // The runtime-shaped names that remain describe WORK, not a destination:
    // a dispatch envelope is a request, and the mapping's `envelopeDigest` is
    // the digest an approval would bind to.
    expect(legacy.LegacyTranslation).toBeDefined()
    const prototype = (legacy.LegacyTranslation as { prototype: object }).prototype
    expect(prototype).not.toHaveProperty("acknowledgeLaunch")
    expect(prototype).not.toHaveProperty("launchIntents")
  })

  it("...and in the source of the whole legacy layer", () => {
    // An export check alone would miss a destination that is only ever written
    // as a string literal on a record type. So the source is searched directly:
    // no file under `src/orchestration/legacy/`, and no legacy route, may name
    // a runtime destination in its CODE.
    const banned = ["legacy.runtime.launch", "LegacyLaunch", "legacyLaunch", "outbox", "destination"]
    // Collected rather than asserted in place so that a violation names the
    // file AND the name, which an in-place boolean cannot do.
    const violations: string[] = []
    for (const file of legacySourceFiles()) {
      const code = codeLines(readFileSync(file, "utf8"))
      for (const name of banned) {
        if (code.includes(name)) violations.push(`${file} names '${name}'`)
      }
    }
    expect(violations).toEqual([])
  })

  it("names no destination in what acceptTrigger returns", () => {
    const { translation, commands } = kernelApp()
    const acceptance = translation.acceptTrigger(legacyJob())

    expect(acceptance.ok).toBe(true)
    if (!acceptance.ok) return
    // The acceptance is a read-only report of what the kernel recorded. There is
    // no `effect` member to deliver and no outbox id to acknowledge, so there is
    // nothing a route could act on that the kernel has not itself licensed.
    expect(Object.keys(acceptance).sort()).toEqual(["correlation", "events", "mode", "ok"])
    expect(commands.submitted).toHaveLength(1)
    expect(commands.submitted[0]?.type).toBe("run.create")
  })

  it("still records the run, task and dispatch, and holds them for a canonical approval", () => {
    const { translation, commands } = kernelApp()
    expect(translation.acceptTrigger(legacyJob()).ok).toBe(true)

    const command = commands.submitted[0]!
    expect(command.type).toBe("run.create")
    if (command.type !== "run.create") return
    // Recorded as HELD work: a draft, paused run with a pending task. Nothing can
    // schedule that — `COMMAND_MATRIX` requires a `ready` task for
    // `dispatch.propose`, and the task only becomes `ready` once a dispatch is
    // proposed, which needs an approval first. The launch, if it is wanted, is
    // an operator's decision.
    expect(command.payload.run.state).toBe("draft")
    expect(command.payload.run.paused).toBe(true)
    expect(command.payload.tasks[0]?.state).toBe("pending")
    // And the envelope still demands a fresh canonical approval, so a legacy
    // plan annotation can never stand in for one.
    const dispatch = translation.correlate(legacyJob())
    expect(dispatch.ok).toBe(true)
    if (!dispatch.ok) return
    expect(dispatch.dispatch.state).toBe("proposed")
    expect(dispatch.dispatch.envelope.permissionEnvelope.approvalRequirements.capabilities).toEqual(["testing"])
  })

  it("converges on a retried trigger: the same run, one command id, no second effect", () => {
    const { translation, commands } = kernelApp()

    const first = translation.acceptTrigger(legacyJob())
    // Same legacy job, different prompt — the shape of a retried `/trigger`.
    const second = translation.acceptTrigger(legacyJob({ trigger: validTrigger({ prompt: "something else entirely" }) }))

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // The command id is derived from the canonical run, so the retry is the same
    // logical command and the store recognises it rather than minting a run.
    expect(second.correlation?.runId).toBe(first.correlation?.runId)
    expect(commands.submitted.every((command) => command.commandId === commands.submitted[0]!.commandId)).toBe(true)
    expect(commands.submitted).toHaveLength(2)
  })

  it("leaves the /report and /jobs contracts byte-for-byte unchanged", async () => {
    const { translation, commands } = kernelApp()
    const { app, jobManager } = await buildTestApp({ orchestration: { translation } })
    await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })

    // `/jobs/:id` still answers with the bare legacy record plus the additive
    // correlation, and adds no field beyond that.
    const job = await app.inject({ method: "GET", url: "/jobs/job_1" })
    const stored = await jobManager.getJob("job_1")
    expect(job.statusCode).toBe(200)
    expect(job.json().id).toBe(stored.id)
    expect(job.json().status).toBe(stored.status)
    expect(job.json().trigger).toEqual(stored.trigger)
    expect(Object.keys(job.json()).sort()).toEqual(["id", "orchestration", "status", "trigger", ...Object.keys(stored).filter((k) => !["id", "status", "trigger"].includes(k))].sort())

    // A report still unblocks the read model and still submits NO command: an
    // observation must not be able to authorize anything, and after M4-A it has
    // no mechanism with which to try.
    const blocked = await jobManager.createJob(validTrigger({ job_id: "dep_2" }))
    void blocked
    const before = commands.submitted.length
    const report = await app.inject({
      method: "POST",
      url: "/report",
      headers: { authorization: "Bearer secret" },
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        opencode_session_id: "ses_1",
        status: "completed",
        summary: "Testing completed.",
        findings: [],
        artifacts: [],
        started_at: "2026-06-15T00:00:00.000Z",
        completed_at: "2026-06-15T00:01:00.000Z",
      },
    })
    expect(report.statusCode).toBe(202)
    expect(commands.submitted).toHaveLength(before)
  })
})


describe("The mapping agrees with the offline import of the same record", () => {
  it("derives the same canonical identity from either path", async () => {
    // Two derivations of "which canonical run is this legacy job" would be two
    // sources of truth, so both paths are proved to share one.
    const { dryRunLegacyMigration } = await import("../../src/orchestration/legacy/migration.js")
    const job = legacyJob()
    const live = expectOk(translateLegacyJob(job, context()))

    const plan = dryRunLegacyMigration(
      {
        config: {
          agent_id: "test-vps",
          bridge: { host: "0.0.0.0", port: 8787, public_url: "http://test-vps.tailnet:8787" },
          opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
          security: {
            auth_mode: "bearer-token",
            allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: [] }],
          },
          permissions: { default_response: "reject", allow_tools: ["read"], require_plan_approval_for_tools: ["bash"] },
          projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
          agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
          timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
          planning: { plan_annotator_enabled: true, require_approval_for: [] },
        },
        jobs: [job],
        tasksMarkdown: "",
        memory: { projectId: "app", decisions: [], constraints: [], handoffs: [] },
      },
      {
        schemaVersion: 1,
        sourceProfileId: "profile-test-vps",
        meshId: "mesh-primary",
        importedAt: NOW,
        controllerNodeId: "node-test-vps",
        controllerEpoch: 1,
        pathResolutionBase: "/srv/apps",
        agentMappings: context().agentMappings,
        projectMappings: context().projectMappings,
      },
    )
    expect(plan.canCommit).toBe(true)
    const imported = plan.jobs[0]!

    expect(imported.run.runId).toBe(live.run.runId)
    expect(imported.task.taskId).toBe(live.task.taskId)
    expect(imported.dispatch.envelope.dispatchId).toBe(live.dispatch.envelope.dispatchId)
    expect(imported.run.externalReferences).toEqual(live.run.externalReferences)
    expect(imported.task.externalReferences).toEqual(live.task.externalReferences)
    // The envelopes differ only in the role's `createdAt` and the permission
    // envelope, which a live CURRENT authorization and an inert import state
    // differently. The identity and correlation agree, which is what matters.
    expect(imported.dispatch.envelope.targetNodeId).toBe(live.dispatch.envelope.targetNodeId)
  })

  it("changes the mapping digest when a material field of the job changes", () => {
    const base = expectOk(translateLegacyJob(legacyJob(), context())).correlation
    const changedPrompt = expectOk(translateLegacyJob(legacyJob({ trigger: validTrigger({ prompt: "Different." }) }), context())).correlation
    expect(changedPrompt.mappingDigest).not.toBe(base.mappingDigest)
    expect(changedPrompt.envelopeDigest).not.toBe(base.envelopeDigest)
    // The identity is stable even though the content changed, so the job is
    // recognisably the SAME job rather than a new one.
    expect(changedPrompt.runId).toBe(base.runId)
    // And the digest really is a digest of the mapping, not a constant.
    expect(base.mappingDigest).not.toBe(digestJson({}))
  })
})

describe("Legacy jobs have no canonical equivalent", () => {
  it("preserves cross-agent dependencies as references, not as Task edges", () => {
    // A legacy dependency is either a local job id or a remote (agent, job)
    // pair. Canonical Task dependencies are intra-run task ids, so a remote
    // pair has NO canonical equivalent and inventing a cross-run edge would
    // fabricate scheduling authority. This is documented, not silently mapped.
    const result = expectOk(
      translateLegacyJob(
        legacyJob({
          depends_on: ["dep_1"],
          remoteDependencies: [{ agent_id: "dev-main", job_id: "remote-audit", status: "completed" }],
        }),
        context(),
      ),
    )
    expect(result.task.dependencies).toEqual([])
    expect(result.dispatch.envelope.dependencies).toEqual([])
  })

  it("does not treat a legacy plan annotation as canonical approval authority", () => {
    const result = expectOk(
      translateLegacyJob(legacyJob({ trigger: validTrigger({ metadata: { plan_status: "approved", approved_by: "operator" } }) }), context()),
    )
    // The legacy annotation is evidence in the record, not an Approval. The
    // envelope still demands a fresh canonical approval before the dispatch may
    // start, and no approval event is produced.
    expect(result.dispatch.envelope.permissionEnvelope.approvalRequirements.capabilities).toEqual(["testing"])
    expect(result.dispatch.state).toBe("proposed")
  })

  it("keeps the mapping free of bearer material and provider session ids", () => {
    const result = expectOk(
      translateLegacyJob(legacyJob({ opencodeSessionId: "ses_1", trigger: validTrigger() }), context()),
    )
    // A provider session id is a legacy runtime detail with no place on a
    // canonical run/task/dispatch. It must not leak into the mapping.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("ses_1")
    expect(serialized).not.toContain("OPENCODE_SERVER_PASSWORD")
  })
})

describe("Correlation is a first-class, schema-validated value", () => {
  it("round-trips through its schema so a stored correlation cannot drift", () => {
    const { correlation } = expectOk(translateLegacyJob(legacyJob(), context()))
    expect(correlation).toMatchObject({ schemaVersion: 1, disposition: "translated" })
    const asJson = JSON.parse(JSON.stringify(correlation)) as LegacyCorrelation
    expect(asJson).toEqual(correlation)
  })
})

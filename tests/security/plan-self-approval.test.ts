/**
 * Regression for the plan self-approval hole (fixed in 3.1.2).
 *
 * Before the fix, every runtime other than `claude` took the caller-written
 * `metadata.plan_status: "approved"` as an operator's approval: on `/trigger`
 * (engine ingress), in the router drainer, and in the OpenCode tool permission
 * policy. A peer could approve its own work, which ADR 0013 forbids. Approval
 * now comes only from this node's config plus `aibr approve` and the ledger.
 */
import { rmSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../src/config/types.js"
import { IngressDrainer } from "../../src/ingress/drainer.js"
import { createRuntime } from "../../src/ingress/runtime.js"
import { InMemoryApprovalLedger } from "../../src/jobs/approval-ledger.js"
import { JobManager } from "../../src/jobs/manager.js"
import { waitForIdle } from "../../src/opencode/monitor.js"
import { StaticPermissionPolicy } from "../../src/opencode/permissions.js"
import type { OpencodeEvent, PermissionDecision, SessionStatus } from "../../src/opencode/types.js"
import { createSqliteDriver, type SqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import {
  buildTestApp,
  FakeOpencodeClient,
  FakeTaskGraphSyncer,
  InMemoryJobStore,
  testConfig,
  validTrigger,
} from "../integration/fixtures.js"

const OPERATOR = "operator-token-value-123"
const CLAIMED = { plan_status: "approved", approved_by: "attacker", approved_at: "2026-11-26T00:00:00.000Z" }

/** An OpenCode node (the default runtime) where `deployment` is enrolled for dev-main but gated. */
function gatedOpencodeConfig(): BridgeConfig {
  const config = testConfig()
  config.security.allowed_sources = [
    { source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: [] },
  ]
  config.projects = [{ id: "app", path: "/srv/apps/app", capabilities: ["testing", "deployment"] }]
  config.planning = { plan_annotator_enabled: true, require_approval_for: ["deployment"] }
  return config
}

async function harness(config: BridgeConfig = gatedOpencodeConfig()) {
  const ledger = new InMemoryApprovalLedger()
  const monitored: string[] = []
  const reported: string[] = []
  const built = await buildTestApp({
    config,
    operatorToken: OPERATOR,
    approvalLedger: ledger,
    reportTerminalJob: async (job) => {
      reported.push(`${job.id}:${job.status}`)
    },
  })
  const trigger = (overrides: Record<string, unknown>) =>
    built.app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger(overrides) })
  const operator = (url: string, token: string = OPERATOR) =>
    built.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: {} })
  return { ...built, ledger, monitored, reported, trigger, operator }
}

describe("engine /trigger on the OpenCode runtime", () => {
  it("holds a gated capability for the operator even when the caller claims approval", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "deployment", metadata: CLAIMED })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, status: "awaiting_approval", job_id: "job_1" })
    expect(response.json().approve_hint).toContain("aibr approve job_1")
    expect(h.opencode.createdSessions).toBe(0)
    expect(h.opencode.sentPrompts).toBe(0)
    expect((await h.jobManager.getJob("job_1")).status).toBe("awaiting_approval")
    expect((await h.ledger.list()).map((event) => event.type)).toEqual(["approval.requested"])
  })

  it("enforces the source's requires_plan_approval list, which the OpenCode path used to ignore", async () => {
    const config = gatedOpencodeConfig()
    config.planning = { plan_annotator_enabled: true, require_approval_for: [] }
    config.security.allowed_sources = [
      { source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: ["deployment"] },
    ]
    const h = await harness(config)
    const response = await h.trigger({ capability: "deployment" })

    expect(response.json()).toMatchObject({ status: "awaiting_approval" })
    expect(h.opencode.createdSessions).toBe(0)
  })

  it("launches an ungated capability at once, as before", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "testing" })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ status: "accepted", opencode_session_id: "ses_1" })
    expect(h.opencode.createdSessions).toBe(1)
    expect((await h.jobManager.getJob("job_1")).approval).toBeUndefined()
  })

  it("refuses depends_on on a gated job instead of holding it where a report could be lost", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "deployment", depends_on: [{ agent_id: "dev-main", job_id: "up_1" }] })

    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({ code: "not_implemented" })
    expect(h.opencode.createdSessions).toBe(0)
  })
})

describe("operator approval of an OpenCode job", () => {
  it("launches the held job exactly once, after the decision is in the ledger", async () => {
    const h = await harness()
    await h.trigger({ capability: "deployment", metadata: CLAIMED })

    const approved = await h.operator("/jobs/job_1/approve")
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ job_id: "job_1", status: "running", opencode_session_id: "ses_1" })
    expect(h.opencode.createdSessions).toBe(1)
    expect(h.opencode.sentPrompts).toBe(1)
    const job = await h.jobManager.getJob("job_1")
    expect(job.status).toBe("running")
    expect(job.approval?.status).toBe("approved")
    expect((await h.ledger.list()).map((event) => event.type)).toEqual(["approval.requested", "approval.granted"])

    const again = await h.operator("/jobs/job_1/approve")
    expect(again.statusCode).toBe(409)
    expect(h.opencode.createdSessions).toBe(1)
  })

  it("refuses the peer bearer: the caller cannot approve its own job over the API", async () => {
    const h = await harness()
    await h.trigger({ capability: "deployment", metadata: CLAIMED })

    expect((await h.operator("/jobs/job_1/approve", "secret")).statusCode).toBe(403)
    expect((await h.jobManager.getJob("job_1")).status).toBe("awaiting_approval")
    expect(h.opencode.createdSessions).toBe(0)
  })

  it("leaves the job held when OpenCode is unhealthy, so the operator can retry", async () => {
    const h = await harness()
    await h.trigger({ capability: "deployment" })
    h.opencode.health = async () => false

    const response = await h.operator("/jobs/job_1/approve")
    expect(response.statusCode).toBe(503)
    expect((await h.jobManager.getJob("job_1")).status).toBe("awaiting_approval")
    expect((await h.ledger.list()).map((event) => event.type)).toEqual(["approval.requested"])
  })

  it("fails the job and reports it when the launch fails after approval", async () => {
    const h = await harness()
    await h.trigger({ capability: "deployment" })
    h.opencode.createSession = async () => {
      throw new Error("opencode refused the session")
    }

    const response = await h.operator("/jobs/job_1/approve")
    expect(response.statusCode).toBe(500)
    expect((await h.jobManager.getJob("job_1")).status).toBe("failed")
    expect(h.reported).toEqual(["job_1:failed"])
  })
})

describe("router ingress (aibr worker)", () => {
  let dbPath = ""
  let driver: SqliteDriver | undefined

  afterEach(() => {
    driver?.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true })
  })

  it("refuses a gated capability whatever the caller's plan_status says", async () => {
    dbPath = join(tmpdir(), `aibridge-self-approval-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    driver = createSqliteDriver({ path: dbPath, create: true })
    driver.exec(`
      CREATE TABLE ingress_outbox (
        job_id TEXT PRIMARY KEY, subject_job_id TEXT NOT NULL, route TEXT NOT NULL,
        schema_version TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
        claimed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending','sending','acknowledged','failed')),
        last_error TEXT, terminal_error TEXT, CHECK (attempts >= 0));
    `)
    const config = gatedOpencodeConfig()
    config.bridge = { ...config.bridge, ingress_mode: "router" }
    config.projects = [{ id: "app", path: process.cwd(), capabilities: ["testing", "deployment"] }]
    const opencode = new FakeOpencodeClient()
    const drainer = new IngressDrainer({
      driver,
      config,
      jobManager: new JobManager(new InMemoryJobStore()),
      opencodeClient: opencode,
      taskGraphSyncer: new FakeTaskGraphSyncer(),
      monitorSession: async () => {},
    })
    const payload = { ...validTrigger({ job_id: "job_router", capability: "deployment", project_dir: process.cwd() }), metadata: CLAIMED }
    driver.run(
      `INSERT INTO ingress_outbox (job_id, subject_job_id, route, schema_version, payload_json, created_at_ms, next_attempt_at_ms, attempts, status)
       VALUES ('job_router', 'job_router', 'POST /trigger', 'v1', ?, 1000, 1000, 0, 'pending')`,
      JSON.stringify(payload),
    )

    await drainer.drainOnce(1000)

    const row = drainer.get("job_router")!
    expect(row.status).not.toBe("acknowledged")
    expect(row.last_error).toBe("PLAN_APPROVAL_REQUIRED")
    expect(opencode.createdSessions).toBe(0)
  })
})

describe("OpenCode tool permissions", () => {
  class PermissionAskingClient extends FakeOpencodeClient {
    replies: Array<{ permissionId: string; response: PermissionDecision }> = []
    override async getSessionStatus(): Promise<SessionStatus> {
      return "busy"
    }
    override async subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
      return (async function* () {
        yield { type: "permission.asked", properties: { sessionID: "ses_1", permissionID: "perm_bash", permission: "bash" } }
        yield { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } }
      })()
    }
    override async replyPermission(_s: string, permissionId: string, response: PermissionDecision): Promise<void> {
      this.replies.push({ permissionId, response })
    }
  }

  async function bashReply(operatorApproved: boolean): Promise<PermissionDecision | undefined> {
    const config = testConfig()
    const client = new PermissionAskingClient()
    await waitForIdle(client, "ses_1", {
      directory: "/srv/apps/app",
      timeoutMs: 2000,
      pollIntervalMs: 50,
      permissionPolicy: new StaticPermissionPolicy({ ...config.permissions, require_plan_approval_for_tools: ["bash"] }),
      operatorApproved,
    })
    return client.replies[0]?.response
  }

  it("rejects a gated tool unless an operator approved the job", async () => {
    expect(await bashReply(false)).toBe("reject")
    expect(await bashReply(true)).toBe("always")
  })

  it("derives the approval from the job record, never from the trigger metadata", async () => {
    const h = await harness()
    await h.trigger({ capability: "testing", metadata: CLAIMED })
    const job = await h.jobManager.getJob("job_1")

    expect(job.trigger.metadata?.plan_status).toBe("approved")
    expect(job.approval?.status === "approved").toBe(false)
  })
})

describe("runtime monitor wiring (src/ingress/runtime.ts)", () => {
  class PermissionAskingClient extends FakeOpencodeClient {
    replies: PermissionDecision[] = []
    override async getSessionStatus(): Promise<SessionStatus> {
      return "busy"
    }
    override async subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
      return (async function* () {
        yield { type: "permission.asked", properties: { sessionID: "ses_1", permissionID: "perm_bash", permission: "bash" } }
        yield { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } }
      })()
    }
    override async replyPermission(_s: string, _p: string, response: PermissionDecision): Promise<void> {
      this.replies.push(response)
    }
  }

  async function monitorReply(options: { readonly approve: boolean }): Promise<PermissionDecision | undefined> {
    const directory = await mkdtemp(join(tmpdir(), "aibridge-self-approval-runtime-"))
    const configPath = join(directory, "config.json")
    await writeFile(configPath, await readFile(join(import.meta.dirname, "../../config/test-vps.example.json"), "utf8"))
    const client = new PermissionAskingClient()
    const runtime = await createRuntime({
      configPath,
      stateDir: join(directory, "state"),
      bearerToken: "secret",
      environment: {},
      deps: { opencodeClient: client },
    })
    expect(runtime.config.permissions.require_plan_approval_for_tools).toContain("bash")

    const trigger = { ...validTrigger({ timeout_seconds: 5 }), metadata: CLAIMED } as Parameters<typeof runtime.jobManager.createJob>[0]
    const created = await runtime.jobManager.createJob(trigger, undefined, { awaitingApproval: options.approve })
    if (options.approve) await runtime.jobManager.approve(created.id)
    await runtime.jobManager.attachSession(created.id, "ses_1")
    const running = await runtime.jobManager.markRunning(created.id)
    await runtime.monitorSession(running)
    return client.replies[0]
  }

  it("rejects a gated tool for a job only the caller claims is approved", async () => {
    expect(await monitorReply({ approve: false })).toBe("reject")
  })

  it("allows it once an operator approved the job", async () => {
    expect(await monitorReply({ approve: true })).toBe("always")
  })
})

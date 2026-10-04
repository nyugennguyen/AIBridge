import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BridgeConfig } from "../../src/config/types.js"
import type { OpencodeClient, OpencodeEvent, PermissionDecision, SessionStatus } from "../../src/opencode/types.js"
import type { TaskEntry, TaskGraphSyncer } from "../../src/tasks/types.js"
import type { JobRecord, JobStatus } from "../../src/jobs/types.js"
import type { JobStore } from "../../src/jobs/store.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import { createApp, type AppDependencies } from "../../src/server/app.js"

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()

  async get(id: string): Promise<JobRecord | undefined> {
    return this.jobs.get(id)
  }

  async list(): Promise<JobRecord[]> {
    return [...this.jobs.values()]
  }

  async listByStatus(status: JobStatus): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((j) => j.status === status)
  }

  async save(job: JobRecord): Promise<void> {
    this.jobs.set(job.id, job)
  }
}

export function testConfig(): BridgeConfig {
  return {
    agent_id: "test-vps",
    bridge: { host: "0.0.0.0", port: 8787, public_url: "http://test-vps.tailnet:8787", ingress_mode: "engine" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: ["deployment"] }],
    },
    permissions: { default_response: "reject", allow_tools: ["read"], require_plan_approval_for_tools: ["bash"] },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
    agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
    timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
    planning: { plan_annotator_enabled: true, require_approval_for: ["deployment"] },
  }
}

export class FakeOpencodeClient implements OpencodeClient {
  createdSessions = 0
  sentPrompts = 0

  async health(): Promise<boolean> {
    return true
  }

  async createSession(): Promise<{ id: string }> {
    this.createdSessions += 1
    return { id: `ses_${this.createdSessions}` }
  }

  async sendPromptAsync(): Promise<void> {
    this.sentPrompts += 1
  }

  async subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
    return (async function* () {})()
  }

  async getSessionStatus(): Promise<SessionStatus> {
    return "idle"
  }

  async replyPermission(_sessionId: string, _permissionId: string, _response: PermissionDecision): Promise<void> {}
  async abortSession(): Promise<void> {}
}

export class FakeTaskGraphSyncer implements TaskGraphSyncer {
  synced: Array<{ jobId: string; status: string; metadata?: Record<string, string> }> = []

  async getTasks(): Promise<TaskEntry[]> {
    return []
  }

  async syncJobToTask(jobId: string, status: string, metadata?: Record<string, string>): Promise<void> {
    this.synced.push({ jobId, status, metadata })
  }

  async parseTaskDependencies(): Promise<Map<string, string[]>> {
    return new Map()
  }

  startWatching(): void {}
  stopWatching(): void {}
}

export interface BuildTestAppOverrides {
  jobManager?: JobManager
  opencodeClient?: FakeOpencodeClient
  taskGraphSyncer?: TaskGraphSyncer
  /**
   * Attaches the orchestration kernel to the legacy routes. Omitted by default
   * so the pre-existing suites keep exercising the RELEASED behaviour; the
   * compatibility suite passes one to prove the contract is identical either way.
   */
  orchestration?: AppDependencies["orchestration"]
}

export async function buildTestApp(overrides: BuildTestAppOverrides = {}) {
  const config = testConfig()
  const opencode = overrides.opencodeClient ?? new FakeOpencodeClient()
  const taskGraphSyncer = overrides.taskGraphSyncer ?? new FakeTaskGraphSyncer()
  const jobManager = overrides.jobManager ?? new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibridge-integration-"))))
  const app = createApp({
    config,
    bearerToken: "secret",
    jobManager,
    opencodeClient: opencode,
    callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
    monitorSession: async () => undefined,
    taskGraphSyncer,
    ...(overrides.orchestration === undefined ? {} : { orchestration: overrides.orchestration }),
  })
  return { app, config, opencode, taskGraphSyncer, jobManager }
}

export function validTrigger(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job_1",
    source_agent_id: "dev-main",
    target_agent_id: "test-vps",
    capability: "testing",
    project_dir: "/srv/apps/app",
    prompt: "Run tests.",
    callback_url: "http://dev-main.tailnet:8787/report",
    timeout_seconds: 60,
    ...overrides,
  }
}

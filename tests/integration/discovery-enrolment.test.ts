/**
 * §18.4 boundary: what the wizard's Step 4 writes is what the routes enforce.
 *
 * The unit suite proves the wizard asks before it enrols. This suite proves the
 * consequence of that answer at the only place it matters: a peer that was
 * DISCOVERED but not ENROLLED gets a 403 from `/trigger`, not a 202. A wizard
 * that enrolled every peer it saw would pass the unit tests and fail here.
 *
 * Everything the fixtures need is defined locally — `tests/integration/fixtures.ts`
 * is not edited by this slice — so this file is self-contained and its shapes
 * are the ones a real `aibr setup` run produces.
 */

import { describe, expect, it } from "vitest"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, type AppDependencies } from "../../src/server/app.js"
import { bridgeConfigSchema } from "../../src/config/schemas.js"
import type { BridgeConfig } from "../../src/config/types.js"
import type { JobManager } from "../../src/jobs/manager.js"
import { JobManager as RealJobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { OpencodeClient, OpencodeEvent, PermissionDecision, SessionStatus } from "../../src/opencode/types.js"
import type { TaskEntry, TaskGraphSyncer } from "../../src/tasks/types.js"

// ── Local fixtures ────────────────────────────────────────────────────────

/** A peer that answered `/health` during setup and was then left alone. */
const DISCOVERED_NOT_ENROLLED = {
  source_agent_id: "bravo-agent",
  capability: "analysis",
  project_dir: "/srv/apps/app",
  url: "http://100.64.0.2:8787",
}

/**
 * A bridge config authored by the wizard with that peer enrolled.
 *
 * `allowed_sources` and `agents` carry the SAME id and the SAME capability
 * list because `assertSourceAuthorized` authorizes on `source_agent_id` AND
 * capability membership, and `/trigger` answers 403 to a source that is in
 * `agents[]` but missing from `allowed_sources[]`. Both halves are therefore
 * driven from one object in the wizard; this fixture is that object, written
 * out the way the config file would hold it.
 */
function wizardConfigWithPeerEnrolled(): BridgeConfig {
  const raw: Record<string, unknown> = {
    agent_id: "test-vps",
    bridge: { host: "100.64.0.7", port: 8787, public_url: "http://test-vps.tailnet:8787" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [
        { source_agent_id: "bravo-agent", capabilities: ["analysis"], requires_plan_approval: [] },
      ],
    },
    permissions: { default_response: "reject", allow_tools: ["read"], require_plan_approval_for_tools: ["bash"] },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["analysis"] }],
    agents: [{ id: "bravo-agent", url: "http://100.64.0.2:8787", capabilities: ["analysis"] }],
    timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
    planning: { plan_annotator_enabled: true, require_approval_for: ["deployment"] },
  }

  // The wizard's own output must satisfy the same parse `writeConfig` applies.
  const parsed = bridgeConfigSchema.parse(raw)
  const config: BridgeConfig = {
    ...parsed,
    security: { ...parsed.security, allowed_sources: parsed.security.allowed_sources.map((s) => ({ ...s, requires_plan_approval: [...s.requires_plan_approval] })) },
    agents: parsed.agents.map((a) => ({ ...a, capabilities: [...a.capabilities] })),
    projects: parsed.projects.map((p) => ({ ...p, capabilities: [...p.capabilities] })),
    permissions: {
      ...parsed.permissions,
      allow_tools: [...parsed.permissions.allow_tools],
      require_plan_approval_for_tools: [...parsed.permissions.require_plan_approval_for_tools],
    },
  }
  return config
}

/** The same node, enrolment skipped: both arrays empty, exactly as written. */
function wizardConfigWithNoPeerEnrolled(): BridgeConfig {
  const config = wizardConfigWithPeerEnrolled()
  return {
    ...config,
    security: { ...config.security, allowed_sources: [] },
    agents: [],
  }
}

class LocalFakeOpencodeClient implements OpencodeClient {
  async health(): Promise<boolean> {
    return true
  }
  async createSession(): Promise<{ id: string }> {
    return { id: "ses_local" }
  }
  async sendPromptAsync(): Promise<void> {}
  async subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
    return (async function* () {})()
  }
  async getSessionStatus(): Promise<SessionStatus> {
    return "idle"
  }
  async replyPermission(_sessionId: string, _permissionId: string, _response: PermissionDecision): Promise<void> {}
  async abortSession(_sessionId: string): Promise<void> {}
}

class LocalFakeTaskGraphSyncer implements TaskGraphSyncer {
  async getTasks(): Promise<TaskEntry[]> {
    return []
  }
  async syncJobToTask(_jobId: string, _status: string, _metadata?: Record<string, string>): Promise<void> {}
  async parseTaskDependencies(): Promise<Map<string, string[]>> {
    return new Map()
  }
  startWatching(): void {}
  stopWatching(): void {}
}

async function buildApp(config: BridgeConfig) {
  const jobManager: JobManager = new RealJobManager(
    new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-discovery-enrolment-"))),
  )
  const dependencies: AppDependencies = {
    config,
    bearerToken: "secret",
    jobManager,
    opencodeClient: new LocalFakeOpencodeClient(),
    callbackReporter: new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      fetcher: async () => new Response(null, { status: 200 }),
    }),
    monitorSession: async () => undefined,
    taskGraphSyncer: new LocalFakeTaskGraphSyncer(),
  }
  return createApp(dependencies)
}

function triggerBody(overrides: Record<string, unknown> = {}) {
  return {
    job_id: `job_${Math.random().toString(36).slice(2, 8)}`,
    source_agent_id: DISCOVERED_NOT_ENROLLED.source_agent_id,
    target_agent_id: "test-vps",
    capability: DISCOVERED_NOT_ENROLLED.capability,
    project_dir: DISCOVERED_NOT_ENROLLED.project_dir,
    prompt: "Run the analysis.",
    callback_url: "http://100.64.0.2:8787/report",
    timeout_seconds: 60,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("a discovered-but-unenrolled peer is refused at /trigger", () => {
  it("returns 403 when the peer is in neither array", async () => {
    // THE BOUNDARY. Setup saw bravo, showed it to the operator, and the
    // operator enrolled nobody. The peer was on the tailnet and answered
    // /health; that buys it nothing.
    const app = await buildApp(wizardConfigWithNoPeerEnrolled())
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: triggerBody(),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: expect.stringContaining("bravo-agent") })
    await app.close()
  })

  it("returns 403 for an unknown capability from an ENROLLED peer", async () => {
    // The other half of the agreement: `allowed_sources[]` grants "analysis"
    // and nothing else, so a request for "deployment" is refused even though
    // the id is enrolled. Enrolling a peer is not enrolling every capability
    // it might ask for.
    const app = await buildApp(wizardConfigWithPeerEnrolled())
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: triggerBody({ capability: "deployment" }),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: expect.stringContaining("not authorized") })
    await app.close()
  })

  it("accepts the enrolled peer for exactly the capability both arrays name", async () => {
    // The positive half, so the 403 above is not passing for the wrong reason:
    // with both arrays in agreement the same request shape is authorized.
    const app = await buildApp(wizardConfigWithPeerEnrolled())
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: triggerBody(),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, target_agent_id: "test-vps" })
    await app.close()
  })

  it("writes an empty allowed_sources[] and agents[] that the schema still accepts", async () => {
    // "Skipping enrolment leaves both arrays untouched" has to survive
    // `writeConfig`'s own `bridgeConfigSchema.parse`, or a skipped setup would
    // throw at the worst possible moment.
    const config = wizardConfigWithNoPeerEnrolled()
    expect(config.security.allowed_sources).toEqual([])
    expect(config.agents).toEqual([])
    expect(() =>
      bridgeConfigSchema.parse({
        ...config,
        bridge: { host: "100.64.0.7", port: 8787, public_url: "http://test-vps.tailnet:8787" },
        opencode: {
          base_url: "http://127.0.0.1:4096",
          server_port: 4096,
          username: "opencode",
          password_env: "OPENCODE_SERVER_PASSWORD",
        },
        timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
        planning: { plan_annotator_enabled: true, require_approval_for: ["deployment"] },
      }),
    ).not.toThrow()
  })
})
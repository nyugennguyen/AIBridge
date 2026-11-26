import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { PING_CAPABILITY } from "../../../src/jobs/ping.js"
import { CLI_VERSION } from "../../../src/version.js"
import { buildTestApp, testConfig, validTrigger } from "../../integration/fixtures.js"

const AUTH = { authorization: "Bearer secret" }

function pingTrigger(overrides: Record<string, unknown> = {}) {
  return validTrigger({ job_id: "ping-1", capability: PING_CAPABILITY, project_dir: "/", prompt: "aibr ping (no-op)", ...overrides })
}

async function setup(config: BridgeConfig = testConfig()) {
  const reports: JobRecord[] = []
  const acceptCalls: unknown[] = []
  const claudeCalls: string[] = []
  const translation = {
    acceptTrigger: (job: unknown) => {
      acceptCalls.push(job)
      return { ok: true }
    },
    correlate: () => ({ ok: true, correlation: {} }),
  } as unknown as NonNullable<NonNullable<Parameters<typeof buildTestApp>[0]>["orchestration"]>["translation"]
  const built = await buildTestApp({
    config,
    reportTerminalJob: async (job) => {
      reports.push(job)
    },
    orchestration: { translation },
    claudeJobRunner: {
      start: async () => {
        claudeCalls.push("start")
        throw new Error("must not run")
      },
      monitor: async () => {
        claudeCalls.push("monitor")
      },
    } as never,
  })
  return { ...built, reports, acceptCalls, claudeCalls }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("POST /trigger with capability aibr.ping", () => {
  it("completes at once for an enrolled source and reports back, running nothing", async () => {
    const h = await setup()
    // dev-main's allowed_sources capabilities are ["testing"]: aibr.ping is not listed.
    const response = await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger() })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, job_id: "ping-1", status: "accepted", target_agent_id: "test-vps" })

    const job = await h.app.inject({ method: "GET", url: "/jobs/ping-1", headers: { authorization: "Bearer secret" } })
    expect(job.statusCode).toBe(200)
    const body = job.json()
    expect(body.status).toBe("completed")
    expect(body.summary).toBe("pong from test-vps")
    expect(body.pong).toEqual({
      agent_id: "test-vps",
      role: "worker",
      runtime: "opencode",
      version: CLI_VERSION,
      capabilities: ["testing"],
      projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
    })

    await flush()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]?.status).toBe("completed")
    expect(h.reports[0]?.id).toBe("ping-1")
    expect(h.opencode.createdSessions).toBe(0)
    expect(h.opencode.sentPrompts).toBe(0)
    expect(h.acceptCalls).toEqual([])
    expect(h.claudeCalls).toEqual([])
  })

  it("works on a Claude-runtime node without touching the runner", async () => {
    const config: BridgeConfig = { ...testConfig(), runtime: { kind: "claude" } }
    const h = await setup(config)
    const response = await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger() })
    expect(response.statusCode).toBe(202)
    const body = (await h.app.inject({ method: "GET", url: "/jobs/ping-1", headers: { authorization: "Bearer secret" } })).json()
    expect(body.status).toBe("completed")
    expect(body.pong.runtime).toBe("claude")
    await flush()
    expect(h.claudeCalls).toEqual([])
    expect(h.reports).toHaveLength(1)
  })

  it("refuses a source that is not enrolled", async () => {
    const h = await setup()
    const response = await h.app.inject({
      method: "POST",
      url: "/trigger",
      headers: AUTH,
      payload: pingTrigger({ source_agent_id: "stranger" }),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe("source_not_enrolled")
  })

  it("refuses repo and depends_on", async () => {
    const h = await setup()
    const withRepo = await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger({ repo: "app" }) })
    expect(withRepo.statusCode).toBe(400)
    expect(withRepo.json().code).toBe("invalid_ping")
    const withDeps = await h.app.inject({
      method: "POST",
      url: "/trigger",
      headers: AUTH,
      payload: pingTrigger({ job_id: "ping-2", depends_on: ["job_x"] }),
    })
    expect(withDeps.statusCode).toBe(400)
  })

  it("answers 404 for another target and 409 for a duplicate job id", async () => {
    const h = await setup()
    const wrong = await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger({ target_agent_id: "other" }) })
    expect(wrong.statusCode).toBe(404)
    expect((await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger() })).statusCode).toBe(202)
    const dup = await h.app.inject({ method: "POST", url: "/trigger", headers: AUTH, payload: pingTrigger() })
    expect(dup.statusCode).toBe(409)
  })

  it("still requires the bearer token", async () => {
    const h = await setup()
    const response = await h.app.inject({ method: "POST", url: "/trigger", payload: pingTrigger() })
    expect(response.statusCode).toBe(401)
    expect(h.reports).toEqual([])
  })
})

/**
 * `BridgeTools.ping` (aibr ping / aibr doctor): a signed no-op job with the
 * reserved capability `aibr.ping`, then a poll of `GET /jobs/:id` until it is
 * completed and — on a node that runs a bridge — its `/report` was delivered.
 */
import { describe, expect, it } from "vitest"
import { BridgeTools, DEFAULT_PING_TIMEOUT_MS, type BridgeToolDeps, type PingOutcome } from "../../../src/mcp/bridge-tools.js"
import { PING_CAPABILITY } from "../../../src/jobs/ping.js"

const HOME = "/home/test"
const TOKEN = "tok_SECRET_abcdef123456"
const PEER_TOKEN = "peer_SECRET_zyxw987654"

function config(role: "worker" | "orchestrator" | "both") {
  return JSON.stringify({
    agent_id: "dev-main",
    role,
    bridge: { host: "127.0.0.1", port: 8787, public_url: "http://dev-main.ts.net:8787/", ingress_mode: "engine" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
    security: { auth_mode: "bearer-token", allowed_sources: [] },
    permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
    projects: [],
    agents: [{ id: "staging", url: "http://staging.ts.net:8787", capabilities: ["investigate"] }],
    timeouts: { default_job_seconds: 900, callback_retry_attempts: 3 },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  })
}

const PONG = {
  agent_id: "staging",
  role: "worker",
  runtime: "claude",
  version: "3.0.0",
  capabilities: ["investigate"],
  projects: [{ id: "app", path: "/srv/app", capabilities: ["investigate"] }],
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown> | null
}

function setup(options: {
  role?: "worker" | "orchestrator" | "both"
  trigger?: (body: Record<string, unknown>) => Response | Promise<Response>
  /** The n-th GET /jobs/:id answer (0-based). */
  job?: (n: number, id: string) => Response
  peerToken?: boolean
}) {
  const calls: Call[] = []
  let clock = 0
  let jobReads = 0
  const sleeps: number[] = []
  const files: Record<string, string> = {
    [`${HOME}/.config/aibridge/dev/config.json`]: config(options.role ?? "worker"),
    [`${HOME}/.local/share/aibridge/dev/secrets/bearer_token`]: `${TOKEN}\n`,
    ...(options.peerToken === true ? { [`${HOME}/.local/share/aibridge/dev/secrets/peers/staging.bearer_token`]: PEER_TOKEN } : {}),
  }
  const deps: BridgeToolDeps = {
    fetch: async (url, init) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v
      })
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null
      calls.push({ url, method: init?.method ?? "GET", headers, body })
      if (url.endsWith("/trigger")) {
        return options.trigger !== undefined ? options.trigger(body ?? {}) : json({ accepted: true, job_id: body?.job_id, status: "accepted" }, 202)
      }
      const id = decodeURIComponent(url.split("/jobs/")[1] ?? "")
      const n = jobReads
      jobReads += 1
      return options.job !== undefined ? options.job(n, id) : json({ id, status: "completed", pong: PONG, callbackDelivery: { status: "delivered" } })
    },
    env: { HOME },
    readFile: async (path) => {
      const value = files[path]
      if (value === undefined) throw new Error("ENOENT")
      return value
    },
    listProfileDirs: async () => ["dev"],
    writeFile: async () => undefined,
    uuid: () => "uuid-1",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  }
  return { tools: new BridgeTools(deps, "dev"), calls, sleeps, jobReads: () => jobReads }
}

function noSecrets(outcome: PingOutcome): void {
  const text = JSON.stringify(outcome)
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(PEER_TOKEN)
}

describe("BridgeTools.ping", () => {
  it("sends a signed no-op trigger and reports the pong and the delivered callback", async () => {
    const t = setup({})
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({
      ok: true,
      target: "staging",
      url: "http://staging.ts.net:8787",
      jobId: "ping-uuid-1",
      stage: "done",
      callback: { status: "delivered" },
      pong: PONG,
    })
    const trigger = t.calls[0]!
    expect(trigger.url).toBe("http://staging.ts.net:8787/trigger")
    expect(trigger.method).toBe("POST")
    expect(trigger.body).toMatchObject({
      job_id: "ping-uuid-1",
      source_agent_id: "dev-main",
      target_agent_id: "staging",
      capability: PING_CAPABILITY,
      callback_url: "http://dev-main.ts.net:8787/report",
    })
    expect(String(trigger.body?.job_id)).toMatch(/^ping-/)
    expect(trigger.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(t.calls[1]?.url).toBe("http://staging.ts.net:8787/jobs/ping-uuid-1")
    noSecrets(outcome)
  })

  it("uses the per-peer token from pairing and never returns it", async () => {
    const t = setup({ peerToken: true, trigger: () => json({ error: `bad ${PEER_TOKEN}` }, 500) })
    const outcome = await t.tools.ping("staging")
    expect(t.calls[0]?.headers.authorization).toBe(`Bearer ${PEER_TOKEN}`)
    expect(outcome.ok).toBe(false)
    noSecrets(outcome)
  })

  it("waits for the callback to settle on a worker", async () => {
    const t = setup({
      job: (n, id) =>
        n < 2
          ? json({ id, status: "completed", pong: PONG, callbackDelivery: { status: "pending" } })
          : json({ id, status: "completed", pong: PONG, callbackDelivery: { status: "delivered" } }),
    })
    const outcome = await t.tools.ping("staging")
    expect(outcome.ok).toBe(true)
    expect(t.jobReads()).toBe(3)
    expect(t.sleeps).toEqual([300, 300])
    expect(outcome.rttMs).toBe(600)
  })

  it("on an orchestrator skips the callback and does not wait for it", async () => {
    const t = setup({ role: "orchestrator", job: (_n, id) => json({ id, status: "completed", pong: PONG }) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: true, stage: "done", callback: { status: "skipped" } })
    expect(t.jobReads()).toBe(1)
    expect(t.sleeps).toEqual([])
  })

  it("waitForCallback:false does not wait either", async () => {
    const t = setup({ job: (_n, id) => json({ id, status: "completed", pong: PONG, callbackDelivery: { status: "pending" } }) })
    const outcome = await t.tools.ping("staging", { waitForCallback: false })
    expect(outcome).toMatchObject({ ok: true, callback: { status: "skipped" }, pong: PONG })
    expect(t.jobReads()).toBe(1)
  })

  it("recognises an older peer that does not know aibr.ping", async () => {
    const t = setup({ trigger: () => json({ error: `Source dev-main is not authorized for capability ${PING_CAPABILITY}` }, 403) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "dispatch", code: "ping_unsupported" })
    expect(outcome.hint).toMatch(/Update aibr on staging/)
    expect(t.jobReads()).toBe(0)
  })

  it("reports an unreachable peer at the dispatch stage", async () => {
    const t = setup({
      trigger: () => {
        throw new Error("connect ECONNREFUSED 100.64.0.2:8787")
      },
    })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "dispatch", code: "unreachable", url: "http://staging.ts.net:8787" })
    expect(outcome.error).toContain("ECONNREFUSED")
    expect(outcome.callback).toEqual({ status: "unknown" })
  })

  it("maps a signature 401 to pairing advice", async () => {
    const t = setup({ trigger: () => json({ error: "signed request required", code: "signature_required" }, 401) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "dispatch", code: "signature_required" })
    expect(outcome.hint).toContain("aibr enroll")
  })

  it("reports a job that ended failed at the job stage", async () => {
    const t = setup({ job: (_n, id) => json({ id, status: "failed", error: "boom" }) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "job", code: "ping_incomplete", callback: { status: "unknown" } })
    expect(outcome.error).toBe("The ping job ended failed: boom.")
  })

  it("reports a job lookup failure at the job stage", async () => {
    const t = setup({ job: () => json({ error: "Job not found" }, 404) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "job", code: "job_not_found", jobId: "ping-uuid-1" })
  })

  it("reports a callback that was not delivered", async () => {
    const t = setup({
      job: (_n, id) =>
        json({ id, status: "completed", pong: PONG, callbackDelivery: { status: "failed", error: `401 with Bearer ${TOKEN}` } }),
    })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "callback", code: "callback_not_delivered", callback: { status: "failed" }, pong: PONG })
    expect(outcome.error).toContain("http://dev-main.ts.net:8787/report")
    expect(outcome.hint).toContain("aibr enroll")
    noSecrets(outcome)
  })

  it("reports a callback still queued at the deadline as not delivered yet", async () => {
    const t = setup({ job: (_n, id) => json({ id, status: "completed", callbackDelivery: { status: "pending", error: "Callback queued for retry" } }) })
    const outcome = await t.tools.ping("staging", { timeoutMs: 1000 })
    expect(outcome).toMatchObject({ ok: false, stage: "callback", callback: { status: "pending", error: "Callback queued for retry" } })
    expect(outcome.error).toContain("not delivered yet (queued for retry)")
  })

  it("times out while the job is still running", async () => {
    const t = setup({ job: (_n, id) => json({ id, status: "running" }) })
    const outcome = await t.tools.ping("staging")
    expect(outcome).toMatchObject({ ok: false, stage: "job", code: "ping_incomplete" })
    expect(outcome.error).toBe(`The ping job did not complete within ${DEFAULT_PING_TIMEOUT_MS / 1000}s (status running).`)
    expect(outcome.rttMs).toBeGreaterThanOrEqual(DEFAULT_PING_TIMEOUT_MS)
  })

  it("stops at the profile stage for an unknown peer, sending nothing", async () => {
    const t = setup({})
    const outcome = await t.tools.ping("nobody")
    expect(outcome).toMatchObject({ ok: false, stage: "profile", code: "unknown_peer", url: null })
    expect(outcome.error).toContain("Enrolled peers: staging")
    expect(t.calls).toEqual([])
  })

  it("ignores a malformed pong", async () => {
    const t = setup({ job: (_n, id) => json({ id, status: "completed", pong: { agent_id: 3 }, callbackDelivery: { status: "delivered" } }) })
    const outcome = await t.tools.ping("staging")
    expect(outcome.ok).toBe(true)
    expect(outcome.pong).toBeUndefined()
  })
})

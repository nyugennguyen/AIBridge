/**
 * Phase 3 (ADR 0012): `aibr enroll issue` / `join` / `revoke` end to end with
 * two in-process nodes, plus client-side signing (callback reporter + MCP).
 *
 * The worker is a real Fastify app (app.inject) with the /enroll endpoint and
 * `request_signing: "required"`; the orchestrator has NO bridge running.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance } from "fastify"
import { describe, expect, it } from "vitest"
import { runEnrollCommand, type EnrollCliDeps } from "../../src/cli/enroll.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { EgressOutboxStore } from "../../src/callback/egress-outbox.js"
import { bridgeConfigSchema } from "../../src/config/schemas.js"
import type { BridgeConfig } from "../../src/config/types.js"
import { resolveProfilePaths } from "../../src/host/paths.js"
import { readConfig, writeConfig } from "../../src/host/profile-store.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import { BridgeTools, defaultBridgeToolDeps } from "../../src/mcp/bridge-tools.js"
import { loadOrCreateNodeKey, peerBearerTokenPath } from "../../src/pairing/files.js"
import { FilePeerStore } from "../../src/pairing/peer-store.js"
import { createPairingAcceptor } from "../../src/pairing/service.js"
import { createProfileRequestSigner } from "../../src/pairing/signer.js"
import { createRequestIdentityGuard } from "../../src/pairing/verifier.js"
import { createApp } from "../../src/server/app.js"
import { FakeOpencodeClient, FakeTaskGraphSyncer, testConfig } from "./fixtures.js"

const TOKEN = "tok-pairing-test-0123456789abcdef"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

function viaApp(app: FastifyInstance): Fetch {
  return async (url, init) => {
    const target = new URL(url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${target.pathname}${target.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    })
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
  }
}

function cliDeps(env: Record<string, string>, fetch: Fetch, out: string[], now: () => number = Date.now): EnrollCliDeps {
  return { env, fetch, now, write: (text) => out.push(text) }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aibr-pairing-"))
  const workerEnv = { HOME: join(root, "worker-home") }
  const orchEnv = { HOME: join(root, "orch-home") }
  const workerPaths = resolveProfilePaths("w", workerEnv)
  const orchPaths = resolveProfilePaths("o", orchEnv)
  const workerConfigPath = join(workerPaths.configDir, "config.json")
  const orchConfigPath = join(orchPaths.configDir, "config.json")

  const worker: BridgeConfig = testConfig()
  worker.security.request_signing = "required"
  worker.security.allowed_sources = []
  worker.agents = []
  await writeConfig(workerConfigPath, worker as unknown as Record<string, unknown>)

  const orch: BridgeConfig = { ...testConfig(), agent_id: "orch", role: "orchestrator", agents: [] }
  orch.bridge = { ...orch.bridge, public_url: "http://orch.tailnet:8787" }
  orch.security = { auth_mode: "bearer-token", allowed_sources: [] }
  await writeConfig(orchConfigPath, orch as unknown as Record<string, unknown>)

  // The running worker bridge: live config object, guard + /enroll over its stateDir.
  const live = bridgeConfigSchema.parse(await readConfig(workerConfigPath))
  const app = createApp({
    config: live,
    bearerToken: TOKEN,
    jobManager: new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-pairing-jobs-")))),
    opencodeClient: new FakeOpencodeClient(),
    callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
    monitorSession: async () => undefined,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    requestIdentity: createRequestIdentityGuard({ mode: "required", peers: new FilePeerStore(workerPaths.stateDir) }),
    pairing: createPairingAcceptor({ config: live, configPath: workerConfigPath, stateDir: workerPaths.stateDir, bearerToken: TOKEN }),
  })
  return { root, app, live, workerEnv, orchEnv, workerPaths, orchPaths, workerConfigPath, orchConfigPath }
}

async function issueCode(env: Record<string, string>, extra: string[] = [], now?: () => number): Promise<string> {
  const out: string[] = []
  const code = await runEnrollCommand(["issue", "--profile", "w", "--capabilities", "testing", ...extra], cliDeps(env, fetch, out, now))
  expect(code).toBe(0)
  const match = /aibr1-[A-Za-z0-9_-]+/.exec(out.join(""))
  expect(match).not.toBeNull()
  return match![0]
}

function mcp(env: Record<string, string>, app: FastifyInstance): BridgeTools {
  return new BridgeTools({ ...defaultBridgeToolDeps(), env, fetch: viaApp(app) }, "o")
}

describe("aibr enroll: issue -> join -> dispatch -> revoke", () => {
  it("pairs two nodes without copying the token, and the paired orchestrator can dispatch signed", async () => {
    const s = await setup()

    // Before pairing, the required-signing worker refuses the orchestrator.
    const code = await issueCode(s.workerEnv)

    const out: string[] = []
    expect(await runEnrollCommand(["join", code, "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), out))).toBe(0)
    const printed = out.join("")
    expect(printed).toContain("Paired with test-vps")
    expect(printed).not.toContain(TOKEN)

    // Worker: allowed_sources[] on disk AND in the live config (no restart needed).
    const workerSaved = bridgeConfigSchema.parse(await readConfig(s.workerConfigPath))
    expect(workerSaved.security.allowed_sources).toContainEqual({ source_agent_id: "orch", capabilities: ["testing"], requires_plan_approval: [] })
    expect(s.live.security.allowed_sources.map((x) => x.source_agent_id)).toContain("orch")
    // Orchestrator role: no bridge, so no callback agents[] entry on the worker.
    expect(workerSaved.agents).toEqual([])

    // Orchestrator: agents[] for the worker, token stored 0600, both sides pinned.
    const orchSaved = bridgeConfigSchema.parse(await readConfig(s.orchConfigPath))
    expect(orchSaved.agents).toEqual([{ id: "test-vps", url: "http://test-vps.tailnet:8787", capabilities: ["testing"] }])
    expect(orchSaved.security.allowed_sources).toEqual([])
    const tokenPath = peerBearerTokenPath(s.orchPaths.secretsDir, "test-vps")
    expect(await readFile(tokenPath, "utf8")).toBe(TOKEN)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(s.orchPaths.secretsDir, "bearer_token"), "utf8")).toBe(TOKEN)
    const workerPins = await new FilePeerStore(s.workerPaths.stateDir).listPeers()
    const orchPins = await new FilePeerStore(s.orchPaths.stateDir).listPeers()
    expect(workerPins.ok && workerPins.value.map((p) => p.agentId)).toEqual(["orch"])
    expect(orchPins.ok && orchPins.value.map((p) => p.agentId)).toEqual(["test-vps"])

    // The Claude Code plugin's MCP client signs with the node key and is accepted.
    const tools = mcp(s.orchEnv, s.app)
    const dispatched = await tools.call("bridge_dispatch", { target: "test-vps", capability: "testing", project_dir: "/srv/apps/app", prompt: "Run tests." })
    const text = dispatched.content[0]!.text
    expect(dispatched.isError).toBeUndefined()
    expect(JSON.parse(text).status).toBe("accepted")
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain("PRIVATE KEY")

    const listed: string[] = []
    expect(await runEnrollCommand(["list", "--profile", "o"], cliDeps(s.orchEnv, fetch, listed))).toBe(0)
    expect(listed.join("")).toContain("test-vps")

    // Revoke on the worker: the next signed request is refused, config entry gone.
    const revoked: string[] = []
    expect(await runEnrollCommand(["revoke", "orch", "--profile", "w"], cliDeps(s.workerEnv, fetch, revoked))).toBe(0)
    const after = await tools.call("bridge_dispatch", { target: "test-vps", capability: "testing", project_dir: "/srv/apps/app", prompt: "Again." })
    expect(after.isError).toBe(true)
    expect(after.content[0]!.text).toContain("403")
    const workerAfter = bridgeConfigSchema.parse(await readConfig(s.workerConfigPath))
    expect(workerAfter.security.allowed_sources.map((x) => x.source_agent_id)).not.toContain("orch")
  })

  it("a code is single-use: a second join is refused with a clear error", async () => {
    const s = await setup()
    const code = await issueCode(s.workerEnv)
    expect(await runEnrollCommand(["join", code, "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), []))).toBe(0)

    const otherEnv = { HOME: join(s.root, "other-home") }
    const otherPaths = resolveProfilePaths("o", otherEnv)
    await writeConfig(join(otherPaths.configDir, "config.json"), { ...(await readConfig(s.orchConfigPath))!, agent_id: "orch2", agents: [] })
    const out: string[] = []
    expect(await runEnrollCommand(["join", code, "--profile", "o"], cliDeps(otherEnv, viaApp(s.app), out))).toBe(1)
    expect(out.join("")).toContain("already been used")
    expect(s.live.security.allowed_sources.map((x) => x.source_agent_id)).not.toContain("orch2")
  })

  it("an expired code is refused with a clear error", async () => {
    const s = await setup()
    const code = await issueCode(s.workerEnv, ["--ttl", "10m"], () => Date.now() - 11 * 60_000)
    const out: string[] = []
    expect(await runEnrollCommand(["join", code, "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), out))).toBe(1)
    expect(out.join("")).toContain("expired")
    const orchSaved = bridgeConfigSchema.parse(await readConfig(s.orchConfigPath))
    expect(orchSaved.agents).toEqual([])
  })

  it("a garbled code and an unknown secret are refused", async () => {
    const s = await setup()
    const out: string[] = []
    expect(await runEnrollCommand(["join", "not-a-code", "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), out))).toBe(1)
    expect(out.join("")).toContain("not an AIBridge pairing code")

    const real = await issueCode(s.workerEnv)
    const [url, , keyId] = Buffer.from(real.slice("aibr1-".length), "base64url").toString("utf8").split("\n")
    const forged = `aibr1-${Buffer.from(`${url}\n${"x".repeat(24)}\n${keyId}`).toString("base64url")}`
    const refused: string[] = []
    expect(await runEnrollCommand(["join", forged, "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), refused))).toBe(1)
    expect(refused.join("")).toContain("Unknown pairing code")
  })

  it("refuses a responder whose key does not match the code (wrong worker)", async () => {
    const s = await setup()
    const code = await issueCode(s.workerEnv)
    const [url, secret] = Buffer.from(code.slice("aibr1-".length), "base64url").toString("utf8").split("\n")
    const wrongKey = `aibr1-${Buffer.from(`${url}\n${secret}\nkey-0000000000000000`).toString("base64url")}`
    const out: string[] = []
    expect(await runEnrollCommand(["join", wrongKey, "--profile", "o"], cliDeps(s.orchEnv, viaApp(s.app), out))).toBe(1)
    expect(out.join("")).toContain("not the worker that printed this code")
  })

  it("issue refuses on an orchestrator profile", async () => {
    const s = await setup()
    const out: string[] = []
    expect(await runEnrollCommand(["issue", "--profile", "o", "--capabilities", "testing"], cliDeps(s.orchEnv, fetch, out))).toBe(1)
    expect(out.join("")).toContain("orchestrator")
  })

  it("/enroll is rate limited", async () => {
    const s = await setup()
    const statuses: number[] = []
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await s.app.inject({ method: "POST", url: "/enroll", payload: { version: 1 } })).statusCode)
    }
    expect(statuses.slice(0, 5).every((code) => code === 400)).toBe(true)
    expect(statuses.slice(5)).toEqual([429, 429])
  })
})

describe("client-side signing: callback reporter", () => {
  async function reportApp() {
    const s = await setup()
    // The worker signs its /report to a peer that pinned it: reuse the worker
    // app as the receiver and pin a "reporter" node there.
    const reporterState = await mkdtemp(join(tmpdir(), "aibr-reporter-"))
    const key = await loadOrCreateNodeKey(reporterState)
    const peers = new FilePeerStore(s.workerPaths.stateDir)
    await peers.pairPeer({ agentId: "dev-main", key: { nodeKeyId: key.keyId, publicKey: key.publicKey, fingerprint: key.fingerprint }, enrollmentId: "enr-r", displayName: "dev-main", now: Date.now() })
    s.live.security.allowed_sources.push({ source_agent_id: "dev-main", capabilities: [], requires_plan_approval: [] })
    return { ...s, reporterState }
  }

  const body = {
    job_id: "job_cb",
    source_agent_id: "dev-main",
    target_agent_id: "test-vps",
    status: "completed" as const,
    summary: "ok",
    findings: [],
    artifacts: [],
    started_at: "2026-06-15T00:00:00.000Z",
    completed_at: "2026-06-15T00:01:00.000Z",
  }

  it("direct delivery is signed and accepted by a required-signing receiver; unsigned is not", async () => {
    const s = await reportApp()
    const signer = createProfileRequestSigner({ stateDir: s.reporterState, agentId: "dev-main" })
    const signed = new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: viaApp(s.app), signer })
    await expect(signed.send("http://test-vps.tailnet:8787/report", body, TOKEN)).resolves.toBeUndefined()
    const unsigned = new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: viaApp(s.app) })
    await expect(unsigned.send("http://test-vps.tailnet:8787/report", body, TOKEN)).rejects.toThrow(/401/)
  })

  it("outbox delivery signs each attempt", async () => {
    const s = await reportApp()
    const signer = createProfileRequestSigner({ stateDir: s.reporterState, agentId: "dev-main" })
    const outboxStore = new EgressOutboxStore(join(s.root, "outbox.db"))
    const reporter = new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: viaApp(s.app), signer, outboxStore, agents: [{ id: "test-vps", url: "http://test-vps.tailnet:8787" }] })
    await expect(reporter.send("http://test-vps.tailnet:8787/report", body, TOKEN, { jobId: "job_cb" })).resolves.toBeUndefined()
    expect(outboxStore.getByJobId("job_cb").map((row) => row.status)).toEqual(["delivered"])
    outboxStore.close()
  })

  it("a node without a key sends unsigned (no headers, no throw)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "aibr-nokey-"))
    const signer = createProfileRequestSigner({ stateDir: empty, agentId: "dev-main" })
    expect(await signer.headersFor("POST", "http://x.tailnet:8787/report", body)).toEqual({})
  })
})

/**
 * Phase 3 (ADR 0012): node signatures on /trigger and /report.
 *
 * Plan "Done" criteria: correct bearer but no signature -> 401 (required);
 * signature from an unpinned key -> 403; replay -> blocked by the replay guard.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bridgeConfigSchema } from "../../src/config/schemas.js"
import type { RequestSigningMode } from "../../src/config/types.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import { NodeKeyPair, publicNodeKeyOf } from "../../src/mesh/identity/node-key.js"
import { FilePeerStore } from "../../src/pairing/peer-store.js"
import { signedRequestHeaders } from "../../src/pairing/signer.js"
import { createRequestIdentityGuard, requireIdentityGuard } from "../../src/pairing/verifier.js"
import { createApp } from "../../src/server/app.js"
import { FakeOpencodeClient, FakeTaskGraphSyncer, testConfig, validTrigger } from "./fixtures.js"

const WORKER_URL = "http://test-vps.tailnet:8787"

async function signingApp(mode: RequestSigningMode, options: { authMode?: "bearer-token" | "none" } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "aibr-signing-"))
  const config = testConfig()
  config.security.request_signing = mode
  if (options.authMode !== undefined) config.security.auth_mode = options.authMode
  const peers = new FilePeerStore(stateDir)
  const app = createApp({
    config,
    bearerToken: options.authMode === "none" ? null : "secret",
    jobManager: new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-signing-jobs-")))),
    opencodeClient: new FakeOpencodeClient(),
    callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
    monitorSession: async () => undefined,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    requestIdentity: createRequestIdentityGuard({ mode, peers }),
  })
  const devKey = NodeKeyPair.generate()
  const pinned = await peers.pairPeer({ agentId: "dev-main", key: publicNodeKeyOf(devKey), enrollmentId: "enr-test", displayName: "dev-main", now: Date.now() })
  expect(pinned.ok).toBe(true)
  return { app, peers, devKey, config }
}

function sign(key: NodeKeyPair, path: string, body: unknown, agentId = "dev-main", nonce?: string) {
  return signedRequestHeaders({ key, agentId, method: "POST", url: `${WORKER_URL}${path}`, body, now: Date.now(), ...(nonce ? { nonce } : {}) })
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job_remote",
    source_agent_id: "dev-main",
    target_agent_id: "test-vps",
    status: "completed",
    summary: "done",
    findings: [],
    artifacts: [],
    started_at: "2026-06-15T00:00:00.000Z",
    completed_at: "2026-06-15T00:01:00.000Z",
    ...overrides,
  }
}

describe("request_signing on /trigger", () => {
  it("required: correct bearer without a signature is 401", async () => {
    const { app } = await signingApp("required")
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })
    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe("signature_required")
  })

  it("required: a valid signature from the pinned key with the bearer is accepted", async () => {
    const { app, devKey } = await signingApp("required")
    const body = validTrigger()
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(devKey, "/trigger", body) }, payload: body })
    expect(response.statusCode).toBe(202)
  })

  it("required: the bearer is still required alongside a valid signature (defence in depth)", async () => {
    const { app, devKey } = await signingApp("required")
    const body = validTrigger()
    const response = await app.inject({ method: "POST", url: "/trigger", headers: sign(devKey, "/trigger", body), payload: body })
    expect(response.statusCode).toBe(401)
  })

  it("required: a signature from an unpinned key is 403", async () => {
    const { app } = await signingApp("required")
    const stranger = NodeKeyPair.generate()
    const body = validTrigger()
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(stranger, "/trigger", body) }, payload: body })
    expect(response.statusCode).toBe(403)
  })

  it("required: an unknown agent id in the signature is 403", async () => {
    const { app } = await signingApp("required")
    const stranger = NodeKeyPair.generate()
    const body = validTrigger({ source_agent_id: "intruder" })
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(stranger, "/trigger", body, "intruder") }, payload: body })
    expect(response.statusCode).toBe(403)
  })

  it("required: a replayed request is refused by the replay guard", async () => {
    const { app, devKey } = await signingApp("required")
    const body = validTrigger({ job_id: "job_replay" })
    const headers = { authorization: "Bearer secret", ...sign(devKey, "/trigger", body) }
    expect((await app.inject({ method: "POST", url: "/trigger", headers, payload: body })).statusCode).toBe(202)
    const replay = await app.inject({ method: "POST", url: "/trigger", headers, payload: body })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().code).toBe("identity.replay_detected")
  })

  it("required: a body source_agent_id that differs from the verified key is 403", async () => {
    const { app, devKey, config } = await signingApp("required")
    config.security.allowed_sources.push({ source_agent_id: "other", capabilities: ["testing"], requires_plan_approval: [] })
    const body = validTrigger({ source_agent_id: "other" })
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(devKey, "/trigger", body) }, payload: body })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe("identity.source_mismatch")
  })

  it("required: a body swapped after signing is refused", async () => {
    const { app, devKey } = await signingApp("required")
    const signedBody = validTrigger({ prompt: "Run tests." })
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret", ...sign(devKey, "/trigger", signedBody) },
      payload: { ...signedBody, prompt: "rm -rf /" },
    })
    expect(response.statusCode).toBe(401)
  })

  it("required: a revoked peer is refused with 403 on its next request", async () => {
    const { app, devKey, peers } = await signingApp("required")
    expect((await peers.revokePeer({ agentId: "dev-main", by: "test", reason: "test", now: Date.now() })).ok).toBe(true)
    const body = validTrigger()
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(devKey, "/trigger", body) }, payload: body })
    expect(response.statusCode).toBe(403)
  })

  it("required + auth_mode none: the signature alone authenticates", async () => {
    const { app, devKey } = await signingApp("required", { authMode: "none" })
    const body = validTrigger()
    expect((await app.inject({ method: "POST", url: "/trigger", payload: body })).statusCode).toBe(401)
    const response = await app.inject({ method: "POST", url: "/trigger", headers: sign(devKey, "/trigger", body), payload: body })
    expect(response.statusCode).toBe(202)
  })

  it("optional: unsigned is accepted on the bearer, a bad signature is refused", async () => {
    const { app, devKey } = await signingApp("optional")
    expect((await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger({ job_id: "a" }) })).statusCode).toBe(202)
    const signedBody = validTrigger({ job_id: "b" })
    const valid = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(devKey, "/trigger", signedBody) }, payload: signedBody })
    expect(valid.statusCode).toBe(202)
    const forged = { ...sign(devKey, "/trigger", validTrigger({ job_id: "c" })), "x-aibridge-mesh-signature": "A".repeat(86) }
    const bad = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...forged }, payload: validTrigger({ job_id: "c" }) })
    expect(bad.statusCode).toBe(401)
    const stranger = NodeKeyPair.generate()
    const unpinnedBody = validTrigger({ job_id: "d" })
    const unpinned = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(stranger, "/trigger", unpinnedBody) }, payload: unpinnedBody })
    expect(unpinned.statusCode).toBe(403)
  })

  it("off: signature headers are ignored", async () => {
    const { app } = await signingApp("off")
    const stranger = NodeKeyPair.generate()
    const body = validTrigger()
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret", ...sign(stranger, "/trigger", body, "intruder") }, payload: body })
    expect(response.statusCode).toBe(202)
  })
})

describe("request_signing on /report", () => {
  it("required: unsigned 401, unpinned 403, mismatch 403, replay refused, valid accepted", async () => {
    const { app, devKey } = await signingApp("required")
    expect((await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret" }, payload: report() })).statusCode).toBe(401)

    const stranger = NodeKeyPair.generate()
    const unpinned = await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret", ...sign(stranger, "/report", report()) }, payload: report() })
    expect(unpinned.statusCode).toBe(403)

    const mismatched = report({ source_agent_id: "someone-else" })
    const mismatch = await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret", ...sign(devKey, "/report", mismatched) }, payload: mismatched })
    expect(mismatch.statusCode).toBe(403)

    const headers = { authorization: "Bearer secret", ...sign(devKey, "/report", report()) }
    expect((await app.inject({ method: "POST", url: "/report", headers, payload: report() })).statusCode).toBe(202)
    expect((await app.inject({ method: "POST", url: "/report", headers, payload: report() })).statusCode).toBe(401)
  })

  it("optional: unsigned reports are still accepted on the bearer", async () => {
    const { app } = await signingApp("optional")
    expect((await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret" }, payload: report() })).statusCode).toBe(202)
  })
})

describe("request_signing wiring", () => {
  it("refuses to build the routes when signing is on but no guard is supplied", () => {
    expect(() => requireIdentityGuard("required", undefined)).toThrow(/request identity guard/)
    expect(requireIdentityGuard("off", undefined)).toBeUndefined()
    expect(requireIdentityGuard(undefined, undefined)).toBeUndefined()
  })

  it("rejects request_signing with ingress_mode router in the schema", () => {
    const config = testConfig()
    for (const mode of ["optional", "required"] as const) {
      const result = bridgeConfigSchema.safeParse({ ...config, bridge: { ...config.bridge, ingress_mode: "router" }, security: { ...config.security, request_signing: mode } })
      expect(result.success).toBe(false)
      expect(JSON.stringify(result.error?.issues)).toContain("not supported with bridge.ingress_mode")
    }
    const off = bridgeConfigSchema.safeParse({ ...config, bridge: { ...config.bridge, ingress_mode: "router" }, security: { ...config.security, request_signing: "off" } })
    expect(off.success).toBe(true)
  })

  it("an existing config without the key keeps its meaning (off)", () => {
    const parsed = bridgeConfigSchema.parse(testConfig())
    expect(parsed.security.request_signing).toBeUndefined()
  })
})

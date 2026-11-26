/**
 * v3.2.0 hardening, security:
 * - `GET /jobs/:id` is no longer anonymous (threat model F-03): the operator
 *   reads any job, a signed peer only its own, an unsigned bearer holder only
 *   where the node does not ask for signatures, and nobody else at all;
 * - a job id is a strict charset wherever one enters (F-01), the store never
 *   writes or reads outside its directory, and ids that differ only in case
 *   are refused (one file on a case-insensitive filesystem);
 * - jobs stored by an older release with ids outside the new charset still
 *   load and stay readable by the operator.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import type { RequestSigningMode, TriggerRequest } from "../../src/config/types.js"
import { InMemoryJobEventLog } from "../../src/jobs/events.js"
import { isStorableJobId, isValidJobId, JOB_ID_PATTERN } from "../../src/jobs/job-id.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JobIdRejectedError, JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { BridgeTools, type BridgeToolDeps } from "../../src/mcp/bridge-tools.js"
import { signedRequestHeaders } from "../../src/pairing/signer.js"
import { jobResultFields } from "../../src/server/routes/jobs.js"
import { validTrigger } from "../integration/fixtures.js"
import { jobApiApp, OPERATOR_TOKEN, WORKER_URL, type Peer } from "../integration/job-api-fixtures.js"

/** Every file under `root`, relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name))).sort()
}

async function harness(signing: RequestSigningMode = "required") {
  const root = await mkdtemp(join(tmpdir(), "aibr-hardening-"))
  const jobsDir = join(root, "state", "jobs")
  const events = new InMemoryJobEventLog()
  const jobManager = new JobManager(new JsonFileJobStore(jobsDir), { events })
  const h = await jobApiApp({ signing, jobManager, events })
  return { ...h, root, jobsDir }
}

const anonymous = (h: Awaited<ReturnType<typeof harness>>, path: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: "GET", url: path, headers })

/** What `GET /jobs/:id` answered before 3.2.0 for this job (no kernel attached). */
async function expectedBody(h: Awaited<ReturnType<typeof harness>>, id: string): Promise<unknown> {
  const job = await h.jobManager.getJob(id)
  return JSON.parse(JSON.stringify({ ...job, ...jobResultFields(job) }))
}

describe("GET /jobs/:id authorization (request_signing: required)", () => {
  it("refuses an unauthenticated caller with 401 before looking the job up", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main", "completed")
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "secret" }, { authorization: "Basic c2VjcmV0" }] as Record<string, string>[]) {
      const known = await anonymous(h, "/jobs/job_1", headers)
      expect(known.statusCode).toBe(401)
      expect(known.body).not.toContain("Run tests.")
      // The same answer for an id that does not exist: existence is not disclosed.
      expect((await anonymous(h, "/jobs/no_such_job", headers)).statusCode).toBe(401)
    }
  })

  it("refuses the bare bearer with no signature (401 signature_required)", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main")
    const response = await anonymous(h, "/jobs/job_1", { authorization: "Bearer secret" })
    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe("signature_required")
  })

  it("lets a signed peer read its own job, with the body unchanged", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main", "completed")
    const response = await h.asPeer("dev-main", "GET", "/jobs/job_1")
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(await expectedBody(h, "job_1"))
  })

  it("never lets a signed peer read another peer's job (403 not_job_requester)", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main", "completed")
    const response = await h.asPeer("qa-node", "GET", "/jobs/job_1")
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: "This job was not dispatched by the caller", code: "not_job_requester" })
    expect(response.body).not.toContain("Run tests.")
  })

  it("refuses a signature borrowed from another peer's identity", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main")
    // qa-node's key, claiming to be dev-main.
    const forged = signedRequestHeaders({ key: h.keys["qa-node"], agentId: "dev-main", method: "GET", url: `${WORKER_URL}/jobs/job_1`, body: null, now: Date.now() })
    const response = await anonymous(h, "/jobs/job_1", { authorization: "Bearer secret", ...forged })
    expect([401, 403]).toContain(response.statusCode)
    expect(response.body).not.toContain("Run tests.")
  })

  it("lets the operator read any job, under the approve rules (loopback only by default)", async () => {
    const h = await harness()
    await h.seedJob("job_1", "dev-main", "completed")
    await h.seedJob("job_2", "qa-node")
    for (const id of ["job_1", "job_2"]) {
      const response = await h.asOperator("GET", `/jobs/${id}`)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(await expectedBody(h, id))
    }
    const remote = await h.asOperator("GET", "/jobs/job_1", { remoteAddress: "198.51.100.7" })
    expect(remote.statusCode).toBe(403)
    expect(remote.json().code).toBe("operator_not_local")
  })

  it("answers 404 to an authorized caller for an unknown job", async () => {
    const h = await harness()
    expect((await h.asOperator("GET", "/jobs/no_such_job")).statusCode).toBe(404)
    expect((await h.asPeer("dev-main", "GET", "/jobs/no_such_job")).statusCode).toBe(404)
  })
})

describe("GET /jobs/:id authorization on nodes that do not require signatures", () => {
  it("optional: an unsigned bearer holder reads the job (unpaired orchestrator), a signature still scopes", async () => {
    const h = await harness("optional")
    await h.seedJob("job_1", "dev-main", "completed")
    expect((await anonymous(h, "/jobs/job_1")).statusCode).toBe(401)
    const unsigned = await anonymous(h, "/jobs/job_1", { authorization: "Bearer secret" })
    expect(unsigned.statusCode).toBe(200)
    expect(unsigned.json()).toEqual(await expectedBody(h, "job_1"))
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_1")).statusCode).toBe(200)
    expect((await h.asPeer("qa-node", "GET", "/jobs/job_1")).json().code).toBe("not_job_requester")
  })

  it("off: the bearer is required (no more anonymous reads) and is enough, as before", async () => {
    const h = await harness("off")
    await h.seedJob("job_1", "dev-main", "completed")
    expect((await anonymous(h, "/jobs/job_1")).statusCode).toBe(401)
    expect((await anonymous(h, "/jobs/job_1", { authorization: "Bearer wrong" })).statusCode).toBe(401)
    const bearer = await anonymous(h, "/jobs/job_1", { authorization: "Bearer secret" })
    expect(bearer.statusCode).toBe(200)
    expect(bearer.json()).toEqual(await expectedBody(h, "job_1"))
    // A node that does not verify signatures cannot scope by them either:
    // a signed request is a bearer request there.
    expect((await h.asPeer("qa-node", "GET", "/jobs/job_1")).statusCode).toBe(200)
    expect((await h.asOperator("GET", "/jobs/job_1")).statusCode).toBe(200)
  })
})

describe("GET /jobs/:id callers keep working", () => {
  /** The Claude Code plugin's MCP tools, talking to the real routes; `paired: false` has no node key. */
  function mcpFor(h: Awaited<ReturnType<typeof harness>>, peer: Peer, paired = true): BridgeTools {
    const home = "/home/mcp"
    const files: Record<string, string> = {
      [`${home}/.config/aibridge/dev/config.json`]: JSON.stringify({
        agent_id: peer,
        bridge: { host: "127.0.0.1", port: 8787, public_url: `http://${peer}.tailnet:8787`, ingress_mode: "engine" },
        opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
        security: { auth_mode: "bearer-token", allowed_sources: [] },
        permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
        projects: [],
        agents: [{ id: "test-vps", url: WORKER_URL, capabilities: ["testing"] }],
        timeouts: { default_job_seconds: 900, callback_retry_attempts: 1 },
        planning: { plan_annotator_enabled: false, require_approval_for: [] },
      }),
      [`${home}/.local/share/aibridge/dev/secrets/bearer_token`]: "secret\n",
    }
    const deps = {
      fetch: async (url: string, init?: RequestInit) => {
        const target = new URL(url)
        const response = await h.app.inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: `${target.pathname}${target.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        })
        return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
      },
      env: { HOME: home },
      readFile: async (path: string) => {
        const value = files[path]
        if (value === undefined) throw new Error("ENOENT")
        return value
      },
      listProfileDirs: async () => ["dev"],
      writeFile: async () => undefined,
      uuid: () => "unused",
      now: () => Date.now(),
      sleep: async () => undefined,
      loadKey: async () => (paired ? h.keys[peer] : null),
    } as BridgeToolDeps
    return new BridgeTools(deps, "dev")
  }

  const toolJson = (result: { readonly content: readonly { readonly text: string }[] }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>

  it("bridge_status and bridge_result from the paired requester (signed) on a `required` node", async () => {
    const h = await harness("required")
    await h.seedJob("job_1", "dev-main", "completed")
    const tools = mcpFor(h, "dev-main")
    const status = await tools.call("bridge_status", { job_id: "job_1", target: "test-vps" })
    expect(status.isError).toBeUndefined()
    expect(toolJson(status)).toMatchObject({ job_id: "job_1", status: "completed", final: true })
    const result = await tools.call("bridge_result", { job_id: "job_1", target: "test-vps" })
    expect(result.isError).toBeUndefined()
    expect(toolJson(result)).toMatchObject({ job_id: "job_1", status: "completed" })
  })

  it("bridge_status from another paired peer is forbidden and names the reason", async () => {
    const h = await harness("required")
    await h.seedJob("job_1", "dev-main", "completed")
    const result = await mcpFor(h, "qa-node").call("bridge_status", { job_id: "job_1", target: "test-vps" })
    expect(result.isError).toBe(true)
    expect(toolJson(result).code).toBe("forbidden")
  })

  it("an unpaired orchestrator polls with the bearer on an `optional` or `off` node, and is told to pair on a `required` one", async () => {
    for (const signing of ["optional", "off"] as const) {
      const h = await harness(signing)
      await h.seedJob("job_1", "dev-main", "completed")
      const status = await mcpFor(h, "dev-main", false).call("bridge_status", { job_id: "job_1", target: "test-vps" })
      expect(status.isError, signing).toBeUndefined()
      expect(toolJson(status).status).toBe("completed")
    }
    const h = await harness("required")
    await h.seedJob("job_1", "dev-main", "completed")
    const refused = await mcpFor(h, "dev-main", false).call("bridge_status", { job_id: "job_1", target: "test-vps" })
    expect(refused.isError).toBe(true)
    expect(toolJson(refused).code).toBe("signature_required")
  })

  it("aibr approve's lookup (operator credential) and the status_url of a dispatch both work", async () => {
    const h = await harness("required")
    const triggered = await h.triggerAs("dev-main", { job_id: "job_9" })
    expect(triggered.statusCode).toBe(202)
    expect(triggered.json().status_url).toBe(`${WORKER_URL}/jobs/job_9`)
    expect((await h.asOperator("GET", "/jobs/job_9")).json().id).toBe("job_9")
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_9")).json().id).toBe("job_9")
  })
})

/** Ids that must never be accepted for a new job. */
const HOSTILE_IDS = [
  "../x",
  "..\\x",
  "a/b",
  "a\\b",
  "..",
  ".",
  "%2e%2e",
  "%2e%2e%2fx",
  "/etc/passwd",
  "/tmp/x",
  "C:\\x",
  "a\0b",
  ".hidden",
  "-rf",
  "_x",
  "a b",
  "x;rm -rf ~",
  "a.json",
  "é",
  "",
  "a".repeat(129),
  "a".repeat(10_000),
]

describe("job ids: strict charset at every entry point, nothing outside the jobs directory", () => {
  it("the pattern accepts every id this project mints", () => {
    for (const id of [
      "job_123e4567-e89b-12d3-a456-426614174000", // engine default
      "123e4567-e89b-12d3-a456-426614174000", // bridge_send / aibr send
      "ping-123e4567-e89b-12d3-a456-426614174000", // aibr ping
      "0123456789abcdef0123456789abcdef", // router mint
      "job_1",
      "job-1",
      "a".repeat(128),
    ]) {
      expect(isValidJobId(id), id).toBe(true)
    }
    for (const id of HOSTILE_IDS) expect(isValidJobId(id), JSON.stringify(id.slice(0, 20))).toBe(false)
    expect(JOB_ID_PATTERN.source).toBe("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
  })

  it("POST /trigger refuses each hostile job_id with 400 and writes nothing", async () => {
    const h = await harness("required")
    for (const id of HOSTILE_IDS) {
      const response = await h.triggerAs("dev-main", { job_id: id })
      expect(response.statusCode, JSON.stringify(id.slice(0, 20))).toBe(400)
    }
    expect(await h.jobManager.listJobs()).toEqual([])
    expect(await filesUnder(h.root)).toEqual([])
  })

  it("POST /trigger refuses a hostile remote depends_on job_id", async () => {
    const h = await harness("required")
    for (const id of ["../x", "a/b", "%2e%2e"]) {
      const response = await h.triggerAs("dev-main", { depends_on: [{ agent_id: "qa-node", job_id: id }] })
      expect(response.statusCode).toBe(400)
    }
    expect(await filesUnder(h.root)).toEqual([])
  })

  it("POST /report refuses each hostile job_id with 400", async () => {
    const h = await harness("required")
    for (const id of HOSTILE_IDS) {
      const body = {
        job_id: id,
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        status: "completed",
        summary: "done",
        findings: [],
        artifacts: [],
        started_at: "2026-11-26T00:00:00.000Z",
        completed_at: "2026-11-26T00:01:00.000Z",
      }
      const response = await h.app.inject({
        method: "POST",
        url: "/report",
        headers: {
          authorization: "Bearer secret",
          ...signedRequestHeaders({ key: h.keys["dev-main"], agentId: "dev-main", method: "POST", url: `${WORKER_URL}/report`, body, now: Date.now() }),
        },
        payload: body,
      })
      expect(response.statusCode, JSON.stringify(id.slice(0, 20))).toBe(400)
    }
    expect(await filesUnder(h.root)).toEqual([])
  })

  it("routes with a job id in the path never reach a file outside the jobs directory", async () => {
    const h = await harness("required")
    // A job record planted NEXT TO the jobs directory, as `../escaped` would have written it.
    await mkdir(join(h.root, "state"), { recursive: true })
    const planted = { ...(await h.seedJob("job_1", "dev-main")), id: "../escaped" }
    await writeFile(join(h.root, "state", "escaped.json"), JSON.stringify(planted))
    for (const path of [
      "/jobs/..%2Fescaped",
      "/jobs/..%2fescaped",
      "/jobs/%2e%2e%2Fescaped",
      "/jobs/..%5Cescaped",
      "/jobs/%2Fetc%2Fpasswd",
      "/jobs/%2e%2e",
      `/jobs/${"a".repeat(5_000)}`,
    ]) {
      for (const suffix of ["", "/events"]) {
        const response = await h.asOperator("GET", `${path}${suffix}`)
        expect(response.statusCode, `${path}${suffix}`).toBe(404)
        expect(response.body).not.toContain("escaped")
      }
      for (const action of ["cancel", "approve", "reject"]) {
        const response = await h.asOperator("POST", `${path}/${action}`)
        expect([400, 404], `${path}/${action}`).toContain(response.statusCode)
      }
    }
    expect(await filesUnder(h.root)).toEqual(["state/escaped.json", "state/jobs/job_1.json"])
  })

  it("the store refuses to write an id that would leave its directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibr-store-"))
    const store = new JsonFileJobStore(join(root, "jobs"))
    const job = { id: "x", trigger: validTrigger() as TriggerRequest, status: "accepted", createdAt: "t", updatedAt: "t" } as JobRecord
    for (const id of ["../x", "..\\x", "a/b", "/tmp/x", "..", ".", "a\0b", "", "a".repeat(300)]) {
      await expect(store.save({ ...job, id })).rejects.toBeInstanceOf(JobIdRejectedError)
      expect(await store.get(id)).toBeUndefined()
    }
    expect(await filesUnder(root)).toEqual([])
    expect(isStorableJobId("task.1")).toBe(true)
  })
})

describe("job ids that differ only in case", () => {
  it("POST /trigger answers 409 for a case-only variant of an existing id and keeps the first job", async () => {
    const h = await harness("required")
    expect((await h.triggerAs("dev-main", { job_id: "Job_A" })).statusCode).toBe(202)
    for (const id of ["job_a", "JOB_A", "Job_A"]) {
      const response = await h.triggerAs("dev-main", { job_id: id })
      expect(response.statusCode, id).toBe(409)
      expect(response.json().error).toMatch(/already exists/)
    }
    expect((await h.jobManager.listJobs()).map((job) => job.id)).toEqual(["Job_A"])
    expect(await filesUnder(h.jobsDir)).toEqual(["Job_A.json"])
  })

  it("the store refuses a new case-only variant but keeps updating jobs it already holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibr-store-case-"))
    const manager = new JobManager(new JsonFileJobStore(dir))
    await manager.createJob(validTrigger({ job_id: "abc" }) as TriggerRequest)
    await expect(manager.createJob(validTrigger({ job_id: "ABC" }) as TriggerRequest)).rejects.toThrow(/already exists.*letter case/)
    await manager.markFailed("abc", "stopped")
    expect((await manager.getJob("abc")).status).toBe("failed")
  })
})

describe("jobs stored by an older release", () => {
  it("still load, stay readable by the operator and can change state, whatever their id", async () => {
    const h = await harness("required")
    const legacy = (id: string, source: string): JobRecord =>
      ({
        id,
        trigger: { ...(validTrigger({ job_id: id, source_agent_id: source }) as TriggerRequest) },
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }) as JobRecord
    await mkdir(h.jobsDir, { recursive: true })
    for (const id of ["task.1", "weird id", "_old", "Old.Case"]) {
      await writeFile(join(h.jobsDir, `${id}.json`), JSON.stringify(legacy(id, "dev-main")))
    }
    for (const id of ["task.1", "weird id", "_old", "Old.Case"]) {
      const response = await h.asOperator("GET", `/jobs/${encodeURIComponent(id)}`)
      expect(response.statusCode, id).toBe(200)
      expect(response.json().id).toBe(id)
      // Its requester reads it too.
      expect((await h.asPeer("dev-main", "GET", `/jobs/${encodeURIComponent(id)}`)).statusCode).toBe(200)
    }
    await h.jobManager.markFailed("task.1", "interrupted")
    expect((await h.asOperator("GET", "/jobs/task.1")).json().status).toBe("failed")
    // The operator's list shows them as well.
    const listed = (await h.asOperator("GET", "/jobs")).json() as { jobs: { job_id: string }[] }
    expect(listed.jobs.map((job) => job.job_id).sort()).toEqual(["Old.Case", "_old", "task.1", "weird id"])
  })

  it("two older jobs that differ only in case (written on a case-sensitive filesystem) both keep working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibr-store-legacy-case-"))
    const store = new JsonFileJobStore(dir)
    const job = (id: string) =>
      ({ id, trigger: validTrigger({ job_id: "x" }) as TriggerRequest, status: "running", createdAt: "t", updatedAt: "t" }) as JobRecord
    // Seed through a second store instance so the first one loads both from disk.
    const files = await readdir(dir)
    expect(files).toEqual([])
    await writeFile(join(dir, "Dup.json"), JSON.stringify(job("Dup")))
    const second = join(dir, "dup.json")
    let caseSensitive = true
    try {
      await writeFile(second, JSON.stringify(job("dup")), { flag: "wx" })
    } catch {
      caseSensitive = false // macOS default APFS: the two cannot coexist on disk at all
    }
    if (!caseSensitive) return
    for (const id of ["Dup", "dup"]) await expect(store.save({ ...job(id), status: "failed" })).resolves.toBeUndefined()
  })
})

describe("operator token never leaks through the refusal bodies", () => {
  it("does not echo credentials", async () => {
    const h = await harness("required")
    await h.seedJob("job_1", "dev-main")
    const response = await anonymous(h, "/jobs/job_1", { authorization: `Bearer ${OPERATOR_TOKEN}x` })
    expect(response.statusCode).toBe(401)
    expect(response.body).not.toContain(OPERATOR_TOKEN)
  })
})

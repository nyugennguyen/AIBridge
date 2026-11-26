/**
 * v3.2.0 block B, security:
 * - the per-job event log (`<jobs>/<sha256(id)>.events.jsonl`, `GET /jobs/:id/events`)
 *   never carries a token or secret, even when the agent prints them into the
 *   places the adapter does not redact itself (tool names, system subtypes);
 * - a peer can neither list, follow nor cancel another peer's jobs, and cannot
 *   borrow another peer's identity to do so.
 */
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../src/config/types.js"
import { FileJobEventLog, jobEventsFileName } from "../../src/jobs/events.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { PEM_BODY_LINES, SEEDED_SECRETS } from "../../src/memory/redaction/corpus.js"
import { signedRequestHeaders } from "../../src/pairing/signer.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { ClaudeJobRunner } from "../../src/runtime/claude-job-runner.js"
import { redactSecretsFromText } from "../../src/runtime/sanitizer.js"
import { jobApiApp, OPERATOR_TOKEN, WORKER_URL } from "../integration/job-api-fixtures.js"

const CANARIES: Readonly<Record<string, string>> = {
  github: SEEDED_SECRETS.githubClassicPat,
  awsKeyId: SEEDED_SECRETS.awsAccessKeyId,
  slack: SEEDED_SECRETS.slackBotToken,
  google: SEEDED_SECRETS.googleApiKey,
  tailscale: SEEDED_SECRETS.tailscaleAuthKey,
  jwt: SEEDED_SECRETS.jwt,
  opaque: SEEDED_SECRETS.unclassifiedOpaqueKey,
}
/** This node's own secrets: redacted by value. */
const BEARER = "secret"
const CANARY_OAUTH_TOKEN = "CANARY_OAUTH_TOKEN_VALUE_DO_NOT_LEAK"
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY_LINES, "-----END RSA PRIVATE KEY-----"].join("\n")

function expectNoCanary(serialized: string, where: string): void {
  for (const [name, canary] of Object.entries(CANARIES)) expect(serialized.includes(canary), `${where} leaked the ${name} canary`).toBe(false)
  expect(serialized.includes(OPERATOR_TOKEN), `${where} leaked the operator token`).toBe(false)
  expect(serialized.includes(CANARY_OAUTH_TOKEN), `${where} leaked the provider token`).toBe(false)
  for (const line of PEM_BODY_LINES) expect(serialized.includes(line), `${where} leaked PEM key material`).toBe(false)
}

function leaky(): string {
  return [...Object.values(CANARIES), `operator ${OPERATOR_TOKEN}`, `oauth ${CANARY_OAUTH_TOKEN}`, PEM].join("\n")
}

class CanaryProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4343
  exited = false
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (!this.exited) {
      this.exited = true
      this.stdout.end()
      this.emit("exit", null, signal)
    }
    return true
  }
  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }
  finish(code: number): void {
    this.exited = true
    this.stdout.end()
    this.emit("exit", code, null)
  }
}

describe("job events never carry a secret", () => {
  it("redacts what the agent prints into tool names, system events, denials and the result, on disk and over the API", async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), "aibr-job-events-canary-"))
    // As `createRuntime` builds it: block R's redaction over this node's secrets.
    const knownSecrets = [BEARER, OPERATOR_TOKEN]
    const events = new FileJobEventLog(jobsDir, { redact: (text) => redactSecretsFromText(text, knownSecrets) })
    const jobManager = new JobManager(new JsonFileJobStore(jobsDir), {
      events,
      redactError: (text) => redactSecretsFromText(text, knownSecrets),
    })
    const processes: CanaryProcess[] = []
    const monitors: Array<Promise<JobRecord | undefined>> = []
    let runner: ClaudeJobRunner | undefined
    const h = await jobApiApp({
      jobManager,
      events,
      config: (base): BridgeConfig => {
        const { opencode: _opencode, ...rest } = base
        return {
          ...rest,
          runtime: { kind: "claude" },
          capability_profiles: { testing: { allow: ["Read"], requires_approval: false } },
          planning: { plan_annotator_enabled: false, require_approval_for: [] },
        }
      },
      claudeJobRunner: {
        start: (job) => runner!.start(job),
        monitor: (launch) => {
          const monitored = runner!.monitor(launch)
          monitors.push(monitored)
          return monitored
        },
        stop: (id: string, reason: string, waitMs?: number) => runner!.stop(id, reason, waitMs),
        isActive: (id: string) => runner!.isActive(id),
      },
    })
    let now = Date.parse("2026-11-26T00:00:00.000Z")
    runner = new ClaudeJobRunner({
      config: h.config,
      jobManager,
      events,
      reportTerminalJob: async () => undefined,
      knownSecrets,
      pollIntervalMs: 5,
      clock: () => now,
      sleep: async (ms) => {
        now += ms
        await new Promise((done) => setTimeout(done, 1))
      },
      adapterOptions: {
        executablePath: "claude-fake",
        exitDrainGraceMs: 5,
        env: { PATH: "/usr/bin", HOME: "/home/aibr", CLAUDE_CODE_OAUTH_TOKEN: CANARY_OAUTH_TOKEN },
        spawn: () => {
          const proc = new CanaryProcess()
          processes.push(proc)
          return proc
        },
      },
    })

    expect((await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })).statusCode).toBe(202)
    const proc = processes[0]!
    proc.emitEvent({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "m", tools: [] })
    proc.emitEvent({ type: "system", subtype: `leak ${CANARIES.github} ${OPERATOR_TOKEN}` })
    proc.emitEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: `Bash ${CANARIES.slack}`, input: { command: leaky() } }] } })
    proc.emitEvent({ type: "user", message: { content: [{ type: "tool_result", content: leaky(), is_error: false }] } })
    proc.emitEvent({ type: "system", subtype: "permission_denied", tool_name: `Read ${CANARIES.google}`, reason: leaky(), tool_input: { path: leaky() } })
    proc.emitEvent({ type: "result", subtype: "success", is_error: false, result: leaky(), num_turns: 2 })
    proc.finish(0)
    expect((await monitors[0])?.status).toBe("completed")

    const files = (await readdir(jobsDir)).filter((name) => name.endsWith(".events.jsonl"))
    expect(files).toEqual([jobEventsFileName("job_1")])
    const onDisk = await readFile(join(jobsDir, files[0]!), "utf8")
    expect(onDisk).toContain('"type":"tool"')
    expect(onDisk).toContain('"type":"result"')
    // The secrets were there and were replaced, not merely absent.
    expect(onDisk).toContain("Claude Code system event: leak [REDACTED]")
    expect(onDisk).toContain("Tool call: Bash [REDACTED]")
    expectNoCanary(onDisk, "events file")

    const json = await h.asPeer("dev-main", "GET", "/jobs/job_1/events?limit=500")
    expect(json.statusCode).toBe(200)
    expectNoCanary(json.body, "GET /jobs/:id/events")
    const sse = await h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream" })
    expectNoCanary(sse.body, "SSE /jobs/:id/events")
    const listed = await h.asPeer("dev-main", "GET", "/jobs")
    expectNoCanary(listed.body, "GET /jobs")
  })
})

describe("a peer cannot reach another peer's jobs", () => {
  it("cannot list, follow or cancel them", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_dev", "dev-main", "running")
    await h.seedJob("job_qa", "qa-node", "running")

    const listed = (await h.asPeer("qa-node", "GET", "/jobs")).json()
    expect(listed.jobs.map((job: { job_id: string }) => job.job_id)).toEqual(["job_qa"])
    // A filter in the query does not widen the scope.
    const filtered = (await h.asPeer("qa-node", "GET", "/jobs?status=running&source_agent_id=dev-main")).json()
    expect(filtered.jobs.map((job: { job_id: string }) => job.job_id)).toEqual(["job_qa"])

    expect((await h.asPeer("qa-node", "GET", "/jobs/job_dev/events")).statusCode).toBe(403)
    expect((await h.asPeer("qa-node", "GET", "/jobs/job_dev/events", { accept: "text/event-stream" })).statusCode).toBe(403)
    expect((await h.asPeer("qa-node", "POST", "/jobs/job_dev/cancel")).statusCode).toBe(403)
    expect((await h.jobManager.getJob("job_dev")).status).toBe("running")
    expect(h.reports).toHaveLength(0)
  })

  it("cannot claim another peer's identity: the signing key decides, not the header", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_dev", "dev-main", "running")
    // qa-node signs, but names dev-main as the signer.
    const path = "/jobs/job_dev/cancel"
    const forged = signedRequestHeaders({ key: h.keys["qa-node"], agentId: "dev-main", method: "POST", url: `${WORKER_URL}${path}`, body: null, now: Date.now() })
    const response = await h.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${BEARER}`, ...forged } })
    expect([401, 403]).toContain(response.statusCode)
    // A signature over a different path is not accepted for this one.
    const otherPath = signedRequestHeaders({ key: h.keys["dev-main"], agentId: "dev-main", method: "GET", url: `${WORKER_URL}/jobs`, body: null, now: Date.now() })
    const replayed = await h.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${BEARER}`, ...otherPath } })
    expect(replayed.statusCode).toBe(401)
    expect((await h.jobManager.getJob("job_dev")).status).toBe("running")
  })

  it("cannot pass for the operator with the peer bearer, and cannot reach approve, reject or stop-all", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_held", "dev-main", "awaiting_approval")
    await h.seedJob("job_run", "dev-main", "running")
    for (const [method, url] of [
      ["POST", "/jobs/job_held/approve"],
      ["POST", "/jobs/job_held/reject"],
      ["POST", "/operator/stop-all-jobs"],
      ["GET", "/operator/pending-jobs"],
    ] as const) {
      const response = await h.asPeer("dev-main", method, url)
      expect(response.statusCode, `${method} ${url}`).toBe(403)
    }
    expect((await h.jobManager.getJob("job_held")).status).toBe("awaiting_approval")
    expect((await h.jobManager.getJob("job_run")).status).toBe("running")
  })
})

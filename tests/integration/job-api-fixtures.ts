/**
 * A bridge app for the job API (`GET /jobs`, `GET /jobs/:id/events`,
 * `POST /jobs/:id/cancel`) with two paired peers, `dev-main` and `qa-node`,
 * that sign their requests (ADR 0012), an operator credential, an event log
 * and a recording reporter.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import type { BridgeConfig, RequestSigningMode, TriggerRequest } from "../../src/config/types.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { InMemoryApprovalLedger } from "../../src/jobs/approval-ledger.js"
import { InMemoryJobEventLog, type JobEventLog } from "../../src/jobs/events.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { NodeKeyPair, publicNodeKeyOf } from "../../src/mesh/identity/node-key.js"
import { FilePeerStore } from "../../src/pairing/peer-store.js"
import { signedRequestHeaders } from "../../src/pairing/signer.js"
import { createRequestIdentityGuard } from "../../src/pairing/verifier.js"
import { createApp, type AppDependencies } from "../../src/server/app.js"
import { FakeOpencodeClient, FakeTaskGraphSyncer, testConfig, validTrigger } from "./fixtures.js"

export const WORKER_URL = "http://test-vps.tailnet:8787"
export const OPERATOR_TOKEN = "operator-token-for-job-api-tests"
export const PEERS = ["dev-main", "qa-node"] as const
export type Peer = (typeof PEERS)[number]

export interface JobApiAppOptions {
  readonly signing?: RequestSigningMode
  readonly config?: (base: BridgeConfig) => BridgeConfig
  readonly jobManager?: JobManager
  readonly events?: JobEventLog
  readonly claudeJobRunner?: AppDependencies["claudeJobRunner"]
  readonly opencodeClient?: FakeOpencodeClient
  readonly reportTerminalJob?: (job: JobRecord) => Promise<void>
  readonly cancelStopWaitMs?: number
}

export async function jobApiApp(options: JobApiAppOptions = {}) {
  const signing = options.signing ?? "required"
  const stateDir = await mkdtemp(join(tmpdir(), "aibr-job-api-"))
  let config: BridgeConfig = testConfig()
  config = {
    ...config,
    security: {
      ...config.security,
      request_signing: signing,
      allowed_sources: PEERS.map((peer) => ({ source_agent_id: peer, capabilities: ["testing"], requires_plan_approval: ["deployment"] })),
    },
  }
  if (options.config) config = options.config(config)
  const events = options.events ?? new InMemoryJobEventLog()
  const jobManager = options.jobManager ?? new JobManager(new JsonFileJobStore(join(stateDir, "jobs")), { events })
  const peers = new FilePeerStore(stateDir)
  const keys = {} as Record<Peer, NodeKeyPair>
  for (const peer of PEERS) {
    keys[peer] = NodeKeyPair.generate()
    const pinned = await peers.pairPeer({ agentId: peer, key: publicNodeKeyOf(keys[peer]), enrollmentId: `enr-${peer}`, displayName: peer, now: Date.now() })
    expect(pinned.ok).toBe(true)
  }
  const reports: JobRecord[] = []
  const logLines: string[] = []
  const ledger = new InMemoryApprovalLedger()
  const opencode = options.opencodeClient ?? new FakeOpencodeClient()
  const taskGraphSyncer = new FakeTaskGraphSyncer()
  const reportTerminalJob =
    options.reportTerminalJob ??
    (async (job: JobRecord) => {
      reports.push(job)
    })
  const app = createApp({
    config,
    bearerToken: "secret",
    operatorToken: OPERATOR_TOKEN,
    jobManager,
    jobEvents: events,
    jobEventPollMs: 20,
    opencodeClient: opencode,
    callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
    monitorSession: async () => undefined,
    taskGraphSyncer,
    reportTerminalJob,
    approvalLedger: ledger,
    requestIdentity: createRequestIdentityGuard({ mode: signing, peers }),
    localAddresses: () => new Set(["100.64.0.9"]),
    log: (level, message) => logLines.push(`${level} ${message}`),
    ...(options.claudeJobRunner !== undefined ? { claudeJobRunner: options.claudeJobRunner } : {}),
    ...(options.cancelStopWaitMs !== undefined ? { cancelStopWaitMs: options.cancelStopWaitMs } : {}),
  })

  /** A request from `peer`: bearer plus that peer's node signature. */
  const asPeer = (peer: Peer, method: "GET" | "POST", path: string, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: path,
      headers: {
        authorization: "Bearer secret",
        ...signedRequestHeaders({ key: keys[peer], agentId: peer, method, url: `${WORKER_URL}${path}`, body: null, now: Date.now() }),
        ...headers,
      },
    })
  /** A signed `POST /trigger` from `peer`. */
  const triggerAs = (peer: Peer, overrides: Record<string, unknown> = {}) => {
    const body = validTrigger({ source_agent_id: peer, ...overrides })
    return app.inject({
      method: "POST",
      url: "/trigger",
      headers: {
        authorization: "Bearer secret",
        ...signedRequestHeaders({ key: keys[peer], agentId: peer, method: "POST", url: `${WORKER_URL}/trigger`, body, now: Date.now() }),
      },
      payload: body,
    })
  }
  /** A request with the operator credential, from this host unless `remoteAddress` says otherwise. */
  const asOperator = (method: "GET" | "POST", path: string, init: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url: path,
      ...(init.remoteAddress !== undefined ? { remoteAddress: init.remoteAddress } : {}),
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, ...init.headers },
    })
  /** Creates a job dispatched by `source`, optionally moved on to `status`. */
  const seedJob = async (
    id: string,
    source: Peer,
    status: "accepted" | "awaiting_approval" | "running" | "completed" | "failed" | "blocked" = "accepted",
    createdAt?: string,
  ): Promise<JobRecord> => {
    const trigger = validTrigger({ job_id: id, source_agent_id: source }) as TriggerRequest
    await jobManager.createJob(trigger, createdAt, { awaitingApproval: status === "awaiting_approval" })
    if (status === "running" || status === "completed" || status === "failed") {
      await jobManager.markLaunchStarted(id)
      await jobManager.markRunning(id)
    }
    if (status === "completed") await jobManager.markCompleted(id)
    if (status === "failed") await jobManager.markFailed(id, "it broke")
    if (status === "blocked") await jobManager.markBlocked(id, ["missing-dependency"])
    return jobManager.getJob(id)
  }

  return { app, config, jobManager, events, keys, reports, logLines, ledger, opencode, taskGraphSyncer, asPeer, asOperator, triggerAs, seedJob }
}

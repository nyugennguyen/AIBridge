/**
 * The engine-to-wire projection: job states, workspaces, and the queue bridge.
 *
 * Split from `publisher.test.ts` because these are decisions rather than I/O. What
 * is under test is the mapping from the engine's eleven job statuses onto the wire's
 * four, and the refusal to publish a queue row's payload -- both of which would be
 * invisible in a test that only checked that frames arrived.
 */

import { describe, expect, it } from "vitest"

import { EngineWorldSource, QueueBridge, startIpcBus } from "../../../src/ipc/bridge.js"
import type { IngressRecord } from "../../../src/ingress/drainer.js"
import type { JobRecord, JobStatus } from "../../../src/jobs/types.js"
import type { BridgeConfig } from "../../../src/config/types.js"
import type { IpcPublisher } from "../../../src/ipc/publisher.js"
import { testConfig } from "../../integration/fixtures.js"

/**
 * The shared fixture config, with a SECOND project added.
 *
 * Two rather than one because the workspace projection is a lookup: a single project
 * would make every containment question trivially true, and the case that matters --
 * a sibling path sharing a name prefix -- needs two roots to be a question at all.
 */
function config(): BridgeConfig {
  return {
    ...testConfig(),
    projects: [
      { id: "app", path: "/srv/apps/app", capabilities: ["testing"] },
      { id: "api", path: "/srv/apps/api", capabilities: ["testing"] },
    ],
  }
}

/** A job record in one status. */
function job(status: JobStatus, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    trigger: {
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "do the thing",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
      metadata: undefined,
    },
    status,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:01:00.000Z",
    ...overrides,
  }
}

function aSource(jobs: JobRecord[]): EngineWorldSource {
  return new EngineWorldSource({
    config: config(),
    jobManager: {
      listJobs: async () => jobs,
      getJob: async (id: string) => {
        const found = jobs.find((candidate) => candidate.id === id)
        if (found === undefined) throw new Error("not found")
        return found
      },
      markFailed: async (id: string, error: string) => {
        const found = jobs.find((candidate) => candidate.id === id)
        if (found === undefined) throw new Error("not found")
        found.status = "failed"
        found.error = error
        return found
      },
    } as unknown as ConstructorParameters<typeof EngineWorldSource>[0]["jobManager"],
    outboxPendingCount: () => 7,
  })
}

describe("the job state projection", () => {
  it("maps every in-progress status onto working, not idle", () => {
    // `idle` means READINESS. Reporting an admitted job as idle would tell an
    // operator an agent is sitting at a prompt while it is mid-run.
    for (const status of ["received", "accepted", "session_created", "running"] as const) {
      expect(aSource([job(status)]).jobView(job(status)).state).toBe("working")
    }
  })

  it("maps every terminal status onto done", () => {
    for (const status of ["completed", "failed", "timed_out", "callback_failed"] as const) {
      expect(aSource([job(status)]).jobView(job(status)).state).toBe("done")
    }
  })

  it("keeps blocked blocked, and says why", () => {
    const waiting = aSource([job("blocked", { depends_on: ["other-job"] })])
    expect(waiting.jobView(job("blocked", { depends_on: ["other-job"] })).state).toBe("blocked")
    expect(
      waiting.jobView(job("blocked", { depends_on: ["other-job"] })).blockedReason,
    ).toBe("plan_review")

    const prompted = job("blocked")
    expect(aSource([prompted]).jobView(prompted).blockedReason).toBe("permission")
  })

  it("carries no blocked reason for a job that is not blocked", () => {
    // The schema forbids it, and the pair is rendered together: a reason beside a
    // `working` job would read as a reason that does not exist.
    expect(aSource([job("running")]).jobView(job("running")).blockedReason).toBeNull()
  })

  it("redacts a job's error before it can reach a client", () => {
    const token = "sk-aibridge-canary-abcdef"
    const failed = job("failed", { error: `opencode refused: token=${token}` })
    const view = aSource([failed]).jobView(failed)
    expect(view.detail).not.toContain(token)
    expect(view.detail).toContain("[REDACTED_SECRET]")
  })

  it("resolves the project a job's directory belongs to", () => {
    const source = aSource([])
    expect(source.workspaceFor("/srv/apps/app")).toBe("app")
    expect(source.workspaceFor("/srv/apps/api")).toBe("api")
    // Component-wise, not a string prefix: `/srv/apps/application` is not inside
    // `/srv/apps/app`.
    expect(source.workspaceFor("/srv/apps/application")).toBe("application")
  })
})

describe("the snapshot", () => {
  it("reports the queue count and the configured workspaces", () => {
    const snapshot = aSource([]).snapshot()
    expect(snapshot.outboxPendingCount).toBe(7)
    expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["app", "api"])
    expect(snapshot.workspaces.filter((workspace) => workspace.selected)).toHaveLength(1)
  })

  it("reports Tailscale as unknown rather than stopped", () => {
    // This process does not probe Tailscale. Reporting `stopped` would tell an
    // operator their tailnet is down when the truth is that nobody asked, and the
    // schema has a value for precisely that.
    expect(aSource([]).snapshot().tailscale.status).toBe("unknown")
  })

  it("lists no panes, because this build embeds no PTY host", () => {
    expect(aSource([]).snapshot().panes).toEqual([])
  })

  it("moves the selected workspace only to a configured one", () => {
    const source = aSource([])
    expect(source.setActiveWorkspace("api")).toBe(true)
    expect(source.selectedWorkspaceId).toBe("api")
    // A client naming an id this node does not have is a client bug, and clearing
    // the selection would hide it.
    expect(source.setActiveWorkspace("nonexistent")).toBe(false)
    expect(source.selectedWorkspaceId).toBe("api")
  })
})

describe("the queue bridge", () => {
  const row: IngressRecord = {
    job_id: "job-1",
    subject_job_id: "subject-1",
    route: "POST /trigger",
    schema_version: "1",
    payload_json: '{"prompt":"secret"}',
    created_at_ms: 1_700_000_000_000,
    next_attempt_at_ms: null,
    attempts: 3,
    claim_token: "token",
    claimed_at_ms: 1_700_000_000_001,
    status: "sending",
    last_error: null,
    terminal_error: null,
  }

  function recordingPublisher() {
    const added: unknown[] = []
    const removed: string[] = []
    const fake = {
      queueItemsAdded: (entries: readonly unknown[]) => {
        added.push(...entries)
      },
      queueItemRemoved: (jobId: string) => {
        removed.push(jobId)
      },
    } as unknown as IpcPublisher
    return { fake, added, removed }
  }

  it("drops events before a publisher is attached rather than buffering them", () => {
    // The client that eventually attaches is told the queue's state in its opening
    // snapshot, so an event nobody could have received has nowhere useful to go.
    const bridge = new QueueBridge()
    expect(() => bridge.claimed([row])).not.toThrow()
    expect(() => bridge.acknowledged("job-1")).not.toThrow()
  })

  it("publishes a claim and both kinds of departure", () => {
    const { fake, added, removed } = recordingPublisher()
    const bridge = new QueueBridge()
    bridge.attach(fake)

    bridge.claimed([row])
    bridge.acknowledged("job-1")
    // The error code is not forwarded: it is daemon-internal text, and the
    // contract's own comment forbids an error frame carrying internals.
    // The error code is not forwarded: it is daemon-internal text, and the contract's
    // own comment forbids an error frame carrying internals. The parameter is
    // declared so the drainer can pass one.
    bridge.exhausted("job-2")

    expect(added).toEqual([
      { job_id: "job-1", status: "sending", attempts: 3, created_at_ms: 1_700_000_000_000 },
    ])
    // Both departures publish the same event: a row is gone either way, and the job
    // state carries the difference. A second removal variant would mean editing the
    // contract for a distinction the snapshot already has.
    expect(removed).toEqual(["job-1", "job-2"])
  })

  it("never forwards a row's payload", () => {
    const entry = QueueBridge.entryOf(row)
    expect(JSON.stringify(entry)).not.toContain("secret")
    expect(Object.keys(entry)).toEqual(["job_id", "status", "attempts", "created_at_ms"])
  })
})

describe("starting the bus", () => {
  it("refuses a node id that does not satisfy the wire contract", async () => {
    // The daemon's own id, from `config.agent_id`. A value that fails the pattern
    // would otherwise reach every frame and take the FIRST client's connection down,
    // which reads as a client bug rather than as a misconfigured daemon.
    const bad = config()
    await expect(
      startIpcBus({
        config: { ...bad, agent_id: "not a valid id" },
        jobManager: aSource([]) as never as never,
        bridge: new QueueBridge(),
        outboxPendingCount: () => 0,
        socketPath: "/tmp/aibr-bus-should-not-bind.sock",
      }),
    ).rejects.toThrow()
  })
})
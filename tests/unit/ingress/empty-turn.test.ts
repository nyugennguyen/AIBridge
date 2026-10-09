/**
 * A turn that produced no assistant message must not be reported as `completed`.
 *
 * ## The bug this pins
 *
 * `getSessionStatus` returns `state?.type ?? "idle"` (src/opencode/client.ts), so a
 * session opencode has forgotten reads as `idle`. When a turn dies before any
 * message is stored -- a model/provider error, a plugin crashing the event loop --
 * opencode leaves the session idle, `waitForIdle` returns, and the runtime calls
 * `markCompleted`. The job then reports `completed`, its callback is `delivered`,
 * and a caller has no way to tell a real answer from an empty one.
 *
 * Observed live on 2026-10-09 against both a `1.17.13 -> free tier` rejection and a
 * plugin spawning a deleted binary: every job `completed` with an empty assistant
 * message.
 *
 * "Idle" means the session stopped working, not that it succeeded. Only a stored
 * assistant message proves the turn produced anything.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRuntime } from "../../../src/ingress/runtime.js"
import type { OpencodeClient, SessionStatus } from "../../../src/opencode/types.js"
import type { JobRecord } from "../../../src/jobs/types.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aibr-empty-turn-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeConfig(): Promise<string> {
  const configDir = join(dir, "config")
  await mkdir(configDir, { recursive: true })
  const configPath = join(configDir, "config.json")
  await writeFile(
    configPath,
    JSON.stringify({
      agent_id: "test-vps",
      bridge: { host: "127.0.0.1", port: 8787, public_url: "http://127.0.0.1:8787" },
      opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
      security: {
        auth_mode: "bearer-token",
        allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["qa"] }],
      },
      permissions: {
        default_response: "reject",
        allow_tools: ["read"],
        require_plan_approval_for_tools: ["bash"],
      },
      projects: [{ id: "p", path: dir, capabilities: ["qa"] }],
      agents: [],
      timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
      planning: { plan_annotator_enabled: false, require_approval_for: [] },
    }),
  )
  return configPath
}

/**
 * A client whose session goes idle immediately, standing in for a turn that died
 * before storing anything.
 */
class IdleWithNoAnswerClient implements OpencodeClient {
  readonly assistantMessages: number

  constructor(assistantMessages: number) {
    this.assistantMessages = assistantMessages
  }

  health(): Promise<boolean> {
    return Promise.resolve(true)
  }
  createSession(): Promise<{ id: string }> {
    return Promise.resolve({ id: "ses_test" })
  }
  sendPromptAsync(): Promise<void> {
    return Promise.resolve()
  }
  subscribeEvents(): Promise<AsyncIterable<never>> {
    return Promise.resolve((async function* () {})())
  }
  getSessionStatus(): Promise<SessionStatus> {
    // The failure mode: opencode forgot the session, so this reads `idle`.
    return Promise.resolve("idle")
  }
  countAssistantMessages(): Promise<number> {
    return Promise.resolve(this.assistantMessages)
  }
  replyPermission(): Promise<void> {
    return Promise.resolve()
  }
  abortSession(): Promise<void> {
    return Promise.resolve()
  }
}

async function runJob(client: OpencodeClient): Promise<JobRecord> {
  const runtime = await createRuntime({
    configPath: await writeConfig(),
    stateDir: join(dir, "state"),
    bearerToken: "secret",
    environment: {},
    deps: { opencodeClient: client },
  })

  const job = await runtime.jobManager.createJob({
    source_agent_id: "dev-main",
    target_agent_id: "test-vps",
    capability: "qa",
    project_dir: dir,
    prompt: "say something",
    callback_url: "http://127.0.0.1:1/report",
    timeout_seconds: 5,
  })
  const running = await runtime.jobManager.markRunning(job.id)
  const attached = await runtime.jobManager.attachSession(running.id, "ses_test")
  await runtime.monitorSession(attached)
  return runtime.jobManager.getJob(job.id)
}

describe("runtime — a turn with no assistant message", () => {
  it("fails the job instead of reporting completed", async () => {
    const job = await runJob(new IdleWithNoAnswerClient(0))

    expect(job.status).toBe("failed")
    expect(job.status).not.toBe("completed")
  })

  it("names the empty turn in the error so the cause is visible", async () => {
    const job = await runJob(new IdleWithNoAnswerClient(0))

    expect(job.error).toBeTruthy()
    expect(job.error).toMatch(/assistant/i)
  })

  it("still completes when the turn did produce an assistant message", async () => {
    const job = await runJob(new IdleWithNoAnswerClient(1))

    expect(job.status).toBe("completed")
  })
})
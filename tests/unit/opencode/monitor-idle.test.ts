/**
 * A turn that pauses mid-flight is not a finished turn.
 *
 * ## The bug
 *
 * `waitForIdle` returned the first time it saw `idle`. opencode reports a session
 * as idle between steps -- before the first token, and again between tool calls --
 * so a multi-step turn looks idle several times before it is actually over.
 *
 * Observed live on 2026-10-09: an agent reading two files produced four assistant
 * messages, all reasoning/tool parts, over 74 seconds. `waitForIdle` returned at
 * t+5s on the gap before the first tool call, and the job was marked terminal
 * while the turn ran on to produce its answer at t+62s. The answer existed; the
 * bridge had already stopped listening.
 *
 * Idle is therefore a pause, not an ending. The turn ends when the session has
 * been continuously idle for long enough that nothing further is coming.
 */
import { describe, expect, it } from "vitest"

import { waitForIdle } from "../../../src/opencode/monitor.js"
import type { OpencodeClient, OpencodeEvent, PermissionDecision, SessionStatus } from "../../../src/opencode/types.js"
import type { PermissionPolicy } from "../../../src/opencode/types.js"

const policy: PermissionPolicy = { decide: () => "once" as PermissionDecision }

/** A session that is busy, goes idle for a while, then busy again, then idle for good. */
class StutteringSession implements OpencodeClient {
  private busyWindows: Array<[number, number]>
  private readonly startedAt: number

  constructor(busyWindows: Array<[number, number]>) {
    this.busyWindows = busyWindows
    this.startedAt = Date.now()
  }

  private status(): SessionStatus {
    const elapsed = Date.now() - this.startedAt
    return this.busyWindows.some(([from, to]) => elapsed >= from && elapsed < to) ? "busy" : "idle"
  }

  health(): Promise<boolean> {
    return Promise.resolve(true)
  }
  createSession(): Promise<{ id: string }> {
    return Promise.resolve({ id: "ses_stutter" })
  }
  sendPromptAsync(): Promise<void> {
    return Promise.resolve()
  }
  subscribeEvents(): Promise<AsyncIterable<OpencodeEvent>> {
    return Promise.resolve((async function* () {})())
  }
  getSessionStatus(): Promise<SessionStatus> {
    return Promise.resolve(this.status())
  }
  countAssistantMessages(): Promise<number> {
    return Promise.resolve(1)
  }
  replyPermission(): Promise<void> {
    return Promise.resolve()
  }
  abortSession(): Promise<void> {
    return Promise.resolve()
  }
}

describe("waitForIdle — a session that idles between steps", () => {
  it("returns once the session has been idle for the full settle window", async () => {
    // Busy, a 150ms pause, busy again, then done. The pause is shorter than the
    // settle window, as it is in practice: opencode goes idle between steps for
    // well under a second.
    const client = new StutteringSession([[0, 100], [250, 800]])

    const started = Date.now()
    await waitForIdle(client, "ses_stutter", {
      directory: "/tmp",
      timeoutMs: 8_000,
      pollIntervalMs: 25,
      permissionPolicy: policy,
      planMetadata: { plan_status: "approved" },
      settleMs: 300,
    })

    // Work runs to 800ms, then 300ms of settle: ~1100ms. Returning near 100ms or
    // near 300ms means it settled during the mid-turn pause.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
  }, 12_000)

  it("settles after the window even when the session was only ever idle", async () => {
    // A session that never reports `busy` still has to hold `idle` for the full
    // window before the turn counts as over -- otherwise the settle requirement
    // would be skipped entirely for exactly the sessions it exists to protect.
    const client = new StutteringSession([])

    const started = Date.now()
    await waitForIdle(client, "ses_never_busy", {
      directory: "/tmp",
      timeoutMs: 5_000,
      pollIntervalMs: 25,
      permissionPolicy: policy,
      planMetadata: { plan_status: "approved" },
      settleMs: 200,
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  }, 10_000)
})
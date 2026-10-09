import type { PlanMetadata } from "../config/types.js"
import type { OpencodeClient, OpencodeEvent, PermissionAskedEvent, PermissionPolicy, SessionStatusEvent } from "./types.js"

export interface WaitForIdleOptions {
  directory: string
  timeoutMs: number
  pollIntervalMs: number
  permissionPolicy: PermissionPolicy
  planMetadata: PlanMetadata
  /**
   * How long the session must stay idle before the turn counts as over.
   *
   * opencode reports a session idle between steps -- before the first token, and
   * again between tool calls -- so the first `idle` is a pause, not an ending.
   * Observed live on a two-file read: four assistant messages over 74s, with
   * `waitForIdle` returning at t+5s in the gap before the first tool call while
   * the turn ran on to produce its answer at t+62s. Requiring the idle state to
   * persist closes that gap. Tests override this to keep runtime short.
   */
  settleMs?: number
}

/** Default settle window, in ms. */
export const DEFAULT_IDLE_SETTLE_MS = 3_000

export async function waitForIdle(client: OpencodeClient, sessionId: string, options: WaitForIdleOptions): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  const settleMs = options.settleMs ?? DEFAULT_IDLE_SETTLE_MS

  /**
   * A session is finished only once it has been idle continuously for `settleMs`.
   * `busySeen` keeps the very first poll honest: a session that has never been
   * busy has not started yet, so waiting for it to go quiet is meaningless -- it
   * is quiet already.
   */
  let idleSince: number | null = null

  const settledByIdle = async (): Promise<boolean> => {
    const status = await client.getSessionStatus(sessionId)
    if (status !== "idle") {
      // Still working: any settle in progress is void.
      idleSince = null
      return false
    }
    idleSince ??= Date.now()
    return Date.now() - idleSince >= settleMs
  }

  try {
    if (await settledByIdle()) return
  } catch {
    // proceed to monitor
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      if (err) reject(err)
      else resolve()
    }

    timer = setInterval(async () => {
      try {
        if (Date.now() > deadline) {
          finish(new Error(`Timed out waiting for OpenCode session ${sessionId}`))
          return
        }
        if (await settledByIdle()) finish()
      } catch {
        // ignore poll errors
      }
    }, options.pollIntervalMs)

    void (async () => {
      try {
        const events = await client.subscribeEvents(options.directory)
        for await (const event of events) {
          if (settled) break
          if (Date.now() > deadline) {
            finish(new Error(`Timed out waiting for OpenCode session ${sessionId}`))
            break
          }
          if (isPermissionAsked(event) && event.properties.sessionID === sessionId) {
            const permissionId = event.properties.permissionID ?? event.properties.id
            if (!permissionId) throw new Error("OpenCode permission event did not include an ID")
            await client.replyPermission(sessionId, permissionId, options.permissionPolicy.decide(event.properties.permission, options.planMetadata))
          }
          // An idle event is a pause, not an ending: opencode emits one between
          // tool calls. The same settle requirement as the polling path applies,
          // so this records the idle and lets the poller confirm it held.
          if (isSessionStatus(event) && event.properties.sessionID === sessionId && event.properties.status.type === "idle") {
            await settledByIdle()
          }
        }
      } catch {
        // Stream failed; polling timer continues until resolution or timeout
      }
    })()
  })
}

async function waitForIdleByPolling(client: OpencodeClient, sessionId: string, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if ((await client.getSessionStatus(sessionId)) === "idle") return
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for OpenCode session ${sessionId}`)
}

function isSessionStatus(event: OpencodeEvent): event is SessionStatusEvent {
  return event.type === "session.status"
}

function isPermissionAsked(event: OpencodeEvent): event is PermissionAskedEvent {
  return event.type === "permission.asked"
}

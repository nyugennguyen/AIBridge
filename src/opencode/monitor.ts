import type { PlanMetadata } from "../config/types.js"
import type { OpencodeClient, OpencodeEvent, PermissionAskedEvent, PermissionPolicy, SessionStatusEvent } from "./types.js"

export interface WaitForIdleOptions {
  directory: string
  timeoutMs: number
  pollIntervalMs: number
  permissionPolicy: PermissionPolicy
  planMetadata: PlanMetadata
}

export async function waitForIdle(client: OpencodeClient, sessionId: string, options: WaitForIdleOptions): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  try {
    if ((await client.getSessionStatus(sessionId)) === "idle") return
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
        const status = await client.getSessionStatus(sessionId)
        if (status === "idle") finish()
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
          if (isSessionStatus(event) && event.properties.sessionID === sessionId && event.properties.status.type === "idle") {
            finish()
            break
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

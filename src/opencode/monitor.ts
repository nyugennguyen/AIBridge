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
    const events = await client.subscribeEvents(options.directory)
    for await (const event of events) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for OpenCode session ${sessionId}`)
      if (isPermissionAsked(event) && event.properties.sessionID === sessionId) {
        const permissionId = event.properties.permissionID ?? event.properties.id
        if (!permissionId) throw new Error("OpenCode permission event did not include an ID")
        await client.replyPermission(sessionId, permissionId, options.permissionPolicy.decide(event.properties.permission, options.planMetadata))
      }
      if (isSessionStatus(event) && event.properties.sessionID === sessionId && event.properties.status.type === "idle") return
    }
  } catch {
    await waitForIdleByPolling(client, sessionId, options.timeoutMs, options.pollIntervalMs)
  }
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

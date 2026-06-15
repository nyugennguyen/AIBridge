import type { PlanMetadata } from "../config/types.js"

export type PermissionDecision = "reject" | "once" | "always"

export interface CreateSessionResult {
  id: string
}

export type SessionStatus = "idle" | "busy" | "retry" | "unknown"

export interface SessionStatusEvent {
  type: "session.status"
  properties: {
    sessionID: string
    status: { type: SessionStatus }
  }
}

export interface PermissionAskedEvent {
  type: "permission.asked"
  properties: {
    sessionID: string
    permissionID?: string
    id?: string
    permission: string
  }
}

export interface HeartbeatEvent {
  type: "server.heartbeat"
  properties?: Record<string, unknown>
}

export type OpencodeEvent = SessionStatusEvent | PermissionAskedEvent | HeartbeatEvent | { type: string; properties?: Record<string, unknown> }

export interface PermissionPolicy {
  decide(tool: string, metadata: PlanMetadata): PermissionDecision
}

export interface OpencodeClient {
  health(): Promise<boolean>
  createSession(title: string, directory: string): Promise<CreateSessionResult>
  sendPromptAsync(sessionId: string, prompt: string, directory: string): Promise<void>
  subscribeEvents(directory: string): Promise<AsyncIterable<OpencodeEvent>>
  getSessionStatus(sessionId: string): Promise<SessionStatus>
  replyPermission(sessionId: string, permissionId: string, response: PermissionDecision): Promise<void>
  abortSession(sessionId: string): Promise<void>
}

export interface PermissionPolicyConfig {
  default_response: PermissionDecision
  allow_tools: string[]
  require_plan_approval_for_tools: string[]
}

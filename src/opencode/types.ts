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
  sendPromptAsync(sessionId: string, prompt: string, directory: string, policy?: OpencodePromptPolicy): Promise<void>
  subscribeEvents(directory: string): Promise<AsyncIterable<OpencodeEvent>>
  getSessionStatus(sessionId: string): Promise<SessionStatus>
  /**
   * How many assistant messages the session has stored.
   *
   * Not the same question as `getSessionStatus`. That reports whether the session
   * stopped working, and an unknown session reads as `idle`; this reports whether
   * the turn actually said anything. Only the second can distinguish a finished
   * turn from a turn that died before storing output.
   */
  countAssistantMessages(sessionId: string): Promise<number>
  replyPermission(sessionId: string, permissionId: string, response: PermissionDecision): Promise<void>
  abortSession(sessionId: string): Promise<void>
}

export interface OpencodePromptPolicy {
  readonly system?: string
  readonly tools?: Readonly<Record<string, boolean>>
}

export interface PermissionPolicyConfig {
  default_response: PermissionDecision
  allow_tools: string[]
  require_plan_approval_for_tools: string[]
}

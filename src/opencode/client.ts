import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient as SdkOpencodeClient } from "@opencode-ai/sdk/v2"
import type { CreateSessionResult, OpencodeClient, OpencodeEvent, OpencodePromptPolicy, PermissionDecision, SessionStatus } from "./types.js"

export interface SdkOpencodeClientOptions {
  baseUrl: string
  username: string
  password?: string
}

export class SdkOpencodeClientAdapter implements OpencodeClient {
  private readonly client: SdkOpencodeClient

  constructor(private readonly options: SdkOpencodeClientOptions) {
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      headers: this.headers(),
    })
  }

  async health(): Promise<boolean> {
    const response = await fetch(new URL("/global/health", this.options.baseUrl), { headers: this.headers() })
    return response.ok
  }

  async createSession(title: string, directory: string): Promise<CreateSessionResult> {
    const response = await this.client.session.create({ directory, title }, { throwOnError: true })
    const data = response.data as { id?: string; sessionID?: string }
    const id = data.id ?? data.sessionID
    if (!id) throw new Error("OpenCode session create response did not include an ID")
    return { id }
  }

  async sendPromptAsync(sessionId: string, prompt: string, directory: string, policy?: OpencodePromptPolicy): Promise<void> {
    await this.client.session.promptAsync(
      {
        sessionID: sessionId,
        directory,
        parts: [{ type: "text", text: prompt }],
        ...(policy?.system === undefined ? {} : { system: policy.system }),
        ...(policy?.tools === undefined ? {} : { tools: policy.tools }),
      },
      { throwOnError: true },
    )
  }

  async subscribeEvents(directory: string): Promise<AsyncIterable<OpencodeEvent>> {
    const data = await this.client.event.subscribe({ directory }, { throwOnError: true })
    if (isAsyncIterable(data.stream)) return data.stream
    throw new Error("OpenCode event subscription did not return a stream")
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    try {
      const statusRes = await (this.client.session as unknown as { status?: () => Promise<{ data?: Record<string, { type?: SessionStatus }> }> }).status?.()
      if (statusRes?.data !== undefined) {
        const state = statusRes.data[sessionId]
        return state?.type ?? "idle"
      }
    } catch {
      // fallback to session.get
    }
    const response = await this.client.session.get({ sessionID: sessionId }, { throwOnError: true })
    const data = response.data as { status?: { type?: SessionStatus } }
    return data.status?.type ?? "idle"
  }

  async replyPermission(_sessionId: string, permissionId: string, response: PermissionDecision): Promise<void> {
    await this.client.permission.reply({ requestID: permissionId, reply: response }, { throwOnError: true })
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.client.session.abort({ sessionID: sessionId }, { throwOnError: true })
  }

  private headers(): HeadersInit | undefined {
    return this.options.password ? { Authorization: basicAuth(this.options.username, this.options.password) } : undefined
  }
}

export function passwordFromEnv(name: string): string | undefined {
  return process.env[name]
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpencodeEvent> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

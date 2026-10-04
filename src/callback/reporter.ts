import {
  assertDestinationOriginAllowed,
  safeEgressFetch,
  type AgentOriginConfig,
} from "./origin.js"
import type { ReportCallback } from "./types.js"

export interface CallbackReporterOptions {
  attempts: number
  baseDelayMs: number
  agents?: readonly AgentOriginConfig[]
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
}

export class CallbackReporter {
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>
  private readonly sleep: (ms: number) => Promise<void>
  constructor(private readonly options: CallbackReporterOptions) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, ms)
        return promise
      })
  }
  async send(url: string, report: ReportCallback, bearerToken: string): Promise<void> {
    // 1. Destination origin MUST resolve against config.agents[].url BEFORE any
    // Authorization header is constructed (closes F-02, SF-17).
    let expectedOrigin: string
    if (this.options.agents && this.options.agents.length > 0) {
      const allowed = assertDestinationOriginAllowed(url, this.options.agents)
      expectedOrigin = allowed.origin
    } else {
      expectedOrigin = new URL(url).origin
    }

    let lastStatus = 0
    for (let attempt = 1; attempt <= this.options.attempts; attempt += 1) {
      // safeEgressFetch forbids cross-origin redirects (redirect: manual)
      const response = await safeEgressFetch(
        this.fetcher,
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(report),
        },
        expectedOrigin,
      )
      if (response.ok) return
      lastStatus = response.status
      if (attempt < this.options.attempts) {
        const delay = Math.min(this.options.baseDelayMs * 2 ** (attempt - 1), 300_000)
        await this.sleep(delay)
      }
    }
    throw new Error(`Callback failed after ${this.options.attempts} attempts with status ${lastStatus}`)
  }
}

import type { ReportCallback } from "./types.js"

export interface CallbackReporterOptions {
  attempts: number
  baseDelayMs: number
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
}

export class CallbackReporter {
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: CallbackReporterOptions) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async send(url: string, report: ReportCallback, bearerToken: string): Promise<void> {
    let lastStatus = 0
    for (let attempt = 1; attempt <= this.options.attempts; attempt += 1) {
      const response = await this.fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(report),
      })
      if (response.ok) return
      lastStatus = response.status
      if (attempt < this.options.attempts) await this.sleep(this.options.baseDelayMs * 2 ** (attempt - 1))
    }
    throw new Error(`Callback failed after ${this.options.attempts} attempts with status ${lastStatus}`)
  }
}

import {
  assertDestinationOriginAllowed,
  safeEgressFetch,
  type AgentOriginConfig,
} from "./origin.js"
import type { EgressOutboxStore } from "./egress-outbox.js"
import type { ReportCallback } from "./types.js"

export interface CallbackReporterOptions {
  attempts: number
  baseDelayMs: number
  agents?: readonly AgentOriginConfig[]
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  outboxStore?: EgressOutboxStore
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
  async send(
    url: string,
    report: ReportCallback,
    bearerToken: string,
    options?: { readonly jobId?: string },
  ): Promise<void> {
    // 1. Destination origin MUST resolve against config.agents[].url BEFORE any
    // Authorization header is constructed (closes F-02, SF-17).
    let expectedOrigin: string
    if (this.options.agents && this.options.agents.length > 0) {
      const allowed = assertDestinationOriginAllowed(url, this.options.agents)
      expectedOrigin = allowed.origin
    } else {
      expectedOrigin = new URL(url).origin
    }

    // 2. If durable outboxStore is configured (M7-C9), enqueue and drain via outbox
    if (this.options.outboxStore) {
      const row = this.options.outboxStore.enqueue({
        jobId: options?.jobId ?? report.job_id,
        callbackUrl: url,
        report,
        agents: this.options.agents ?? [],
      })

      // Attempt immediate transmission with single-record claim batch size
      const { token, rows } = this.options.outboxStore.claim(Date.now(), 1)
      for (const claimedRow of rows) {
        await this.options.outboxStore.deliverClaimedRow(claimedRow, token, bearerToken, {
          fetcher: this.fetcher,
        })
      }
      const updated = this.options.outboxStore.get(row.outbox_id)
      if (updated?.status === "delivered") {
        return
      }
      if (updated?.status === "failed") {
        throw new Error(
          `Callback failed permanently with status ${updated.terminal_error ?? updated.last_error}`,
        )
      }
      return
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

  /**
   * Drain pending and stale outbox deliveries (M7-C9).
   */
  async drainPending(
    bearerToken: string,
    options?: { readonly limit?: number; readonly nowMs?: number },
  ): Promise<{ delivered: number; failed: number; requeued: number }> {
    if (!this.options.outboxStore) {
      return { delivered: 0, failed: 0, requeued: 0 }
    }

    const nowMs = options?.nowMs ?? Date.now()
    this.options.outboxStore.recoverStale(nowMs)
    const { token, rows } = this.options.outboxStore.claim(nowMs, options?.limit ?? 10)

    let delivered = 0
    let failed = 0
    let requeued = 0

    for (const row of rows) {
      await this.options.outboxStore.deliverClaimedRow(row, token, bearerToken, {
        fetcher: this.fetcher,
        nowMs,
      })
      const after = this.options.outboxStore.get(row.outbox_id)
      if (after?.status === "delivered") {
        delivered++
      } else if (after?.status === "failed") {
        failed++
      } else {
        requeued++
      }
    }

    return { delivered, failed, requeued }
  }
}

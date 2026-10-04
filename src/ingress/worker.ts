/**
 * `aibr worker` — the Tier 2 drain loop as a process.
 *
 * ## What this process is
 *
 * The router admits; this executes. It reads the same `ingress_outbox` the router
 * writes, claims rows, re-runs the full semantic validation the HTTP route used
 * to run ([`IngressDrainer`](../ingress/drainer.ts)), dispatches to OpenCode, and
 * acknowledges. It binds no socket, so a compromised or stalled worker cannot
 * become an ingress.
 *
 * ## Why it never creates the store
 *
 * [`IngressOutbox.fromPath`] opens with `create: false`, and the path rules below
 * are the router's rules, restated. A store that appears from nothing is a queue
 * that has lost every row it admitted: the router would refuse to serve against
 * it, this process would drain an empty one, and both would look healthy.
 * Provisioning is an explicit operator step (`aibr-router --init-store`), which is
 * also why there is no in-memory fallback here and no `catch` that starts one.
 */

import { createRuntime, type RuntimeOptions } from "./runtime.js"
import { IngressDrainer } from "./drainer.js"

export const INGRESS_OUTBOX_ENV = "AIBRIDGE_INGRESS_OUTBOX"

export interface IngressWorkerHandle {
  readonly drainer: IngressDrainer
  /** Resolves once the poll loop has stopped. Idempotent. */
  readonly stopped: Promise<void>
  stop(): void
}

export interface IngressWorkerOptions extends RuntimeOptions {
  /** Defaults to `$AIBRIDGE_INGRESS_OUTBOX`; absolute, or refused. */
  readonly storePath?: string
  readonly pollIntervalMs?: number
}

export const DEFAULT_POLL_INTERVAL_MS = 500

/**
 * Resolve and validate the admission store path.
 *
 * Refuses a relative path for the same reason the router does: which file this
 * process opens must not depend on the working directory a supervisor chose, and
 * two of them produce two empty queues with no error anywhere.
 */
export function resolveStorePath(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = configured ?? env[INGRESS_OUTBOX_ENV]
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${INGRESS_OUTBOX_ENV} is required. The worker drains the queue the router admits into; ` +
        `it has no default path and it never creates one. Provision the store with ` +
        `"aibr-router --init-store" and point this variable at it.`,
    )
  }
  if (!value.startsWith("/")) {
    throw new Error(
      `${INGRESS_OUTBOX_ENV} must be an absolute path, and ${JSON.stringify(value)} is not. ` +
        `A relative path resolves against this process's working directory, which is ` +
        `whatever a supervisor chose, and two of them produce two empty queues.`,
    )
  }
  return value
}

export async function startIngressWorker(
  options: IngressWorkerOptions,
): Promise<IngressWorkerHandle> {
  const storePath = resolveStorePath(options.storePath, options.environment)
  const runtime = await createRuntime(options)

  let drainer: IngressDrainer
  try {
    drainer = IngressDrainer.fromPath(storePath, {
      config: runtime.config,
      jobManager: runtime.jobManager,
      opencodeClient: runtime.opencodeClient,
      callbackReporter: runtime.callbackReporter,
      taskGraphSyncer: runtime.taskGraphSyncer,
      monitorSession: runtime.monitorSession,
    })
  } catch (error) {
    throw new Error(
      `Cannot open the admission store at ${storePath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The store is provisioned by "aibr-router --init-store"; this process will not ` +
        `create it and will not fall back to memory, because an empty in-memory queue ` +
        `would silently drop every row the router admitted.`,
    )
  }

  drainer.start(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)

  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    stop = () => {
      drainer.stop()
      resolve()
    }
  })

  return { drainer, stopped, stop }
}

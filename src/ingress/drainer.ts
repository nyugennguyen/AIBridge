/**
 * M7.7: Worker Drain Loop (ADR 0008 §2.1, §2.2, §2.5, SF-08).
 *
 * ## Invariants
 *
 * 1. Two durable writes: claim and acknowledge are separate commits (SF-08).
 * 2. Tier 2 is the sole semantic authority: re-runs `triggerRequestSchema.safeParse`
 *    and retains complete semantic ordering: `assertSourceAuthorized`,
 *    `assertProjectAllowed`, `ConfigPlanReviewProvider`, opencode health,
 *    dependency resolution, duplicate rejection, and kernel seam.
 * 3. Terminal records are RETAINED with `terminal_error`, never deleted.
 * 4. Stale claims are recovered by `recoverStale`, preserving `attempts`.
 */

import { randomBytes } from "node:crypto"
import {
  triggerRequestSchema,
  reportCallbackSchema,
} from "../config/schemas.js"
import type { BridgeConfig } from "../config/types.js"
import type { JobManager } from "../jobs/manager.js"
import type { JobRecord } from "../jobs/types.js"
import type { OpencodeClient } from "../opencode/types.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import type { CallbackReporter } from "../callback/reporter.js"
import type { LegacyTranslation } from "../orchestration/legacy/translation.js"
import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import { assertSourceAuthorized } from "../security/source-authorization.js"
import { assertProjectAllowed } from "../security/allowlist.js"
import { ConfigPlanReviewProvider } from "../planning/provider.js"
import {
  backoffDelayMs,
  exceedsMaxAttempts,
  MESH_OUTBOX_CLAIM_LEASE_MS,
} from "../mesh/outbox/policy.js"

export interface IngressRecord {
  readonly job_id: string
  readonly subject_job_id: string
  readonly route: string
  readonly schema_version: string
  readonly payload_json: string
  readonly created_at_ms: number
  readonly next_attempt_at_ms: number | null
  readonly attempts: number
  readonly claim_token: string | null
  readonly claimed_at_ms: number | null
  readonly status: "pending" | "sending" | "acknowledged" | "failed"
  readonly last_error: string | null
  readonly terminal_error: string | null
}

/**
 * Told about the durable writes, so a UI can follow the queue.
 *
 * WHY A CALLBACK AND NOT A RETURN VALUE. The claim and the acknowledgement are two
 * separate `COMMIT`s with the work in between, so no single call's return value
 * could describe both ends. A queue event has to be emitted from inside each of
 * them, which means the drainer has to know someone is listening.
 *
 * Notified AFTER the commit, never before: an event published before the write
 * would let a UI show a row the store does not have, and the divergence would only
 * surface when a restarted process read the table.
 *
 * Optional, because a worker with no UI -- which is every deployment today -- must
 * not pay for it, and because the drainer's own tests supply none.
 */
export interface IngressLifecycleObserver {
  /** Rows this claim took, in claim order. */
  claimed?(records: readonly IngressRecord[]): void
  /** A row was acknowledged: dispatch succeeded and the row is done with. */
  acknowledged?(jobId: string): void
  /**
   * A row reached `failed` and will never be retried.
   *
   * Separate from `acknowledged` because the two mean opposite things to an
   * operator, and a sidebar colouring them the same would report a job as
   * succeeded when it was abandoned.
   */
  exhausted?(jobId: string, errorCode: string): void
}

export interface IngressDrainerDependencies {
  readonly driver: SqliteDriver
  readonly config: BridgeConfig
  readonly jobManager: JobManager
  readonly opencodeClient: OpencodeClient
  readonly callbackReporter?: CallbackReporter
  readonly taskGraphSyncer: TaskGraphSyncer
  readonly monitorSession: (job: JobRecord) => Promise<void>
  /** Optional; see {@link IngressLifecycleObserver} for why it is not a return value. */
  readonly observer?: IngressLifecycleObserver
  readonly orchestration?: {
    readonly translation: LegacyTranslation
  }
}

export class IngressDrainer {
  readonly #driver: SqliteDriver
  readonly #config: BridgeConfig
  readonly #jobManager: JobManager
  readonly #opencodeClient: OpencodeClient
  readonly #taskGraphSyncer: TaskGraphSyncer
  readonly #monitorSession: (job: JobRecord) => Promise<void>
  readonly #orchestration?: { readonly translation: LegacyTranslation }
  readonly #planReview: ConfigPlanReviewProvider
  readonly #observer?: IngressLifecycleObserver
  private running = false
  private timer: NodeJS.Timeout | null = null

  constructor(dependencies: IngressDrainerDependencies) {
    this.#driver = dependencies.driver
    this.#config = dependencies.config
    this.#jobManager = dependencies.jobManager
    this.#opencodeClient = dependencies.opencodeClient
    this.#taskGraphSyncer = dependencies.taskGraphSyncer
    this.#monitorSession = dependencies.monitorSession
    this.#observer = dependencies.observer
    this.#orchestration = dependencies.orchestration
    this.#planReview = new ConfigPlanReviewProvider(
      dependencies.config.planning.require_approval_for,
    )
  }

  /**
   * Tell the observer, and never let it break the drain loop.
   *
   * Swallowed rather than propagated because every call site is a durable write
   * that has already committed: an observer that throws must not turn a committed
   * claim into an exception the caller retries, which would double-process the row
   * the `attempts` counter has just incremented.
   */
  #notify(emit: (observer: IngressLifecycleObserver) => void): void {
    const observer = this.#observer
    if (observer === undefined) return
    try {
      emit(observer)
    } catch {
      // An observer is a UI, not the queue. See above.
    }
  }

  static fromPath(
    dbPath: string,
    dependencies: Omit<IngressDrainerDependencies, "driver">,
  ): IngressDrainer {
    const driver = createSqliteDriver({ path: dbPath, create: false })
    driver.exec("PRAGMA journal_mode = WAL")
    driver.exec("PRAGMA synchronous = FULL")
    driver.exec("PRAGMA busy_timeout = 5000")
    return new IngressDrainer({ ...dependencies, driver })
  }

  /**
   * First durable write: claims pending records whose next_attempt_at_ms <= nowMs.
   */
  claim(nowMs: number, limit = 10): { readonly token: string; readonly rows: readonly IngressRecord[] } {
    const token = randomBytes(16).toString("hex")

    this.#driver.transaction(() => {
      this.#driver.run(
        `UPDATE ingress_outbox
         SET status = 'sending',
             claim_token = ?,
             claimed_at_ms = ?,
             attempts = attempts + 1
         WHERE job_id IN (
           SELECT job_id FROM ingress_outbox
           WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
           ORDER BY created_at_ms ASC
           LIMIT ?
         )`,
        token,
        nowMs,
        nowMs,
        limit,
      )
    })

    const rows = this.#driver.all<IngressRecord>(
      "SELECT * FROM ingress_outbox WHERE claim_token = ? AND status = 'sending'",
      token,
    )

    if (rows.length > 0) {
      this.#notify((observer) => observer.claimed?.(rows))
    }

    return { token, rows }
  }

  /**
   * Second durable write: acknowledges executed records.
   */
  acknowledge(jobId: string, claimToken: string): void {
    const result = this.#driver.run(
      `UPDATE ingress_outbox
       SET status = 'acknowledged',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = NULL
       WHERE job_id = ? AND claim_token = ? AND status = 'sending'`,
      jobId,
      claimToken,
    )

    if (result.changes === 0) {
      throw new Error(`Cannot acknowledge record '${jobId}': not in 'sending' status with matching token`)
    }

    this.#notify((observer) => observer.acknowledged?.(jobId))
  }

  /**
   * Marks a record failure, applying exponential backoff or retaining terminal row.
   */
  fail(jobId: string, claimToken: string, errorCode: string, nowMs: number): "requeued" | "terminal" {
    const row = this.#driver.get<{ attempts: number }>(
      "SELECT attempts FROM ingress_outbox WHERE job_id = ? AND claim_token = ? AND status = 'sending'",
      jobId,
      claimToken,
    )

    if (!row) return "requeued"

    const code = errorCode.slice(0, 128)
    if (exceedsMaxAttempts(row.attempts)) {
      this.#driver.run(
        `UPDATE ingress_outbox
         SET status = 'failed',
             claim_token = NULL,
             claimed_at_ms = NULL,
             next_attempt_at_ms = NULL,
             last_error = ?,
             terminal_error = ?
         WHERE job_id = ? AND claim_token = ? AND status = 'sending'`,
        code,
        code,
        jobId,
        claimToken,
      )
      this.#notify((observer) => observer.exhausted?.(jobId, code))
      return "terminal"
    }

    const delayMs = backoffDelayMs(row.attempts)
    const nextAttemptAtMs = nowMs + delayMs

    this.#driver.run(
      `UPDATE ingress_outbox
       SET status = 'pending',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = ?,
           last_error = ?
       WHERE job_id = ? AND claim_token = ? AND status = 'sending'`,
      nextAttemptAtMs,
      code,
      jobId,
      claimToken,
    )

    return "requeued"
  }

  /**
   * Reclaims stale claims whose lease has expired, PRESERVING attempts.
   */
  recoverStale(nowMs: number, leaseMs = MESH_OUTBOX_CLAIM_LEASE_MS): number {
    const threshold = nowMs - leaseMs
    const result = this.#driver.run(
      `UPDATE ingress_outbox
       SET status = 'pending',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = ?
       WHERE status = 'sending' AND claimed_at_ms IS NOT NULL AND claimed_at_ms < ?`,
      nowMs,
      threshold,
    )

    return result.changes
  }

  get(jobId: string): IngressRecord | null {
    const row = this.#driver.get<IngressRecord>(
      "SELECT * FROM ingress_outbox WHERE job_id = ?",
      jobId,
    )
    return row ?? null
  }

  /**
   * How many rows are still claimable.
   *
   * A `COUNT` against the table rather than a counter maintained in memory, and the
   * difference is not a style preference. A maintained counter and the table disagree
   * the moment a drainer is killed mid-cycle, and the count a client is shown must be
   * the pessimistic one -- an optimistic header number is how an operator concludes
   * the queue is empty while rows sit in `sending` waiting for a lease nobody will
   * renew.
   *
   * `pending` only, not `sending`: a row this process has claimed is not waiting for
   * an operator, it is being worked on.
   */
  pendingCount(): number {
    const row = this.#driver.get<{ pending: number }>(
      "SELECT COUNT(*) AS pending FROM ingress_outbox WHERE status = 'pending'",
    )
    return row?.pending ?? 0
  }

  /**
   * Process a single claimed record with complete Tier 2 semantic validation.
   */
  async processRecord(record: IngressRecord, claimToken: string, nowMs: number): Promise<void> {
    try {
      if (record.route === "POST /trigger") {
        await this.processTrigger(record, claimToken)
      } else if (record.route === "POST /report") {
        await this.processReport(record, claimToken)
      } else {
        this.fail(record.job_id, claimToken, `UNKNOWN_ROUTE_${record.route}`, nowMs)
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      this.fail(record.job_id, claimToken, code, nowMs)
    }
  }

  private async processTrigger(record: IngressRecord, claimToken: string): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(record.payload_json)
    } catch {
      this.fail(record.job_id, claimToken, "MALFORMED_JSON", Date.now())
      return
    }

    // 1. Tier 2: re-run triggerRequestSchema.safeParse on delivered payload
    const parsed = triggerRequestSchema.safeParse(payload)
    if (!parsed.success) {
      this.fail(record.job_id, claimToken, "SCHEMA_VALIDATION_FAILED", Date.now())
      return
    }

    const trigger = parsed.data

    if (trigger.target_agent_id !== this.#config.agent_id) {
      this.fail(record.job_id, claimToken, "TARGET_AGENT_MISMATCH", Date.now())
      return
    }

    // 2. Semantic authorization checks (sole authority)
    assertSourceAuthorized(
      trigger.source_agent_id,
      trigger.capability,
      this.#config.security.allowed_sources,
    )
    assertProjectAllowed(trigger.project_dir, this.#config.projects)

    if (!this.#planReview.isApproved(trigger.capability, trigger.metadata)) {
      this.fail(record.job_id, claimToken, "PLAN_APPROVAL_REQUIRED", Date.now())
      return
    }

    // 3. OpenCode server health check
    if (!(await this.#opencodeClient.health())) {
      throw new Error("OPENCODE_SERVER_UNHEALTHY")
    }

    // 4. Duplicate rejection & job store registration
    const { depends_on, task_id } = trigger
    const dependencyReferences = depends_on ?? []
    const localDependencyIds = dependencyReferences.filter(
      (dep): dep is string => typeof dep === "string",
    )
    const hasDeps = dependencyReferences.length > 0

    const depJobs = []
    if (localDependencyIds.length > 0) {
      for (const depId of localDependencyIds) {
        try {
          depJobs.push(await this.#jobManager.getJob(depId))
        } catch {
          this.fail(record.job_id, claimToken, `DEPENDENCY_NOT_FOUND_${depId}`, Date.now())
          return
        }
      }
    }

    let job: JobRecord
    try {
      job = await this.#jobManager.createJob({
        ...trigger,
        job_id: record.job_id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Creation failed"
      if (message.includes("already exists")) {
        // ON CONFLICT convergence: already created, acknowledge admission
        this.acknowledge(record.job_id, claimToken)
        return
      }
      throw error
    }

    const resolvedTaskId = task_id ?? `#${job.id}`
    const hasRemoteDependencies = localDependencyIds.length !== dependencyReferences.length

    if (hasDeps && (hasRemoteDependencies || !depJobs.every((dep) => dep.status === "completed"))) {
      const blocked = await this.#jobManager.markBlocked(job.id, dependencyReferences)
      const blockedAcceptance = this.#orchestration?.translation.acceptTrigger(blocked)
      if (blockedAcceptance !== undefined && !blockedAcceptance.ok) {
        await this.#jobManager.markFailed(job.id, blockedAcceptance.error.message)
        this.fail(record.job_id, claimToken, blockedAcceptance.error.message, Date.now())
        return
      }
      await this.#taskGraphSyncer.syncJobToTask(resolvedTaskId, "blocked", { Job: job.id })
      this.acknowledge(record.job_id, claimToken)
      return
    }

    const acceptance = this.#orchestration?.translation.acceptTrigger(job)
    if (acceptance !== undefined && !acceptance.ok) {
      await this.#jobManager.markFailed(job.id, acceptance.error.message)
      this.fail(record.job_id, claimToken, acceptance.error.message, Date.now())
      return
    }

    const session = await this.#opencodeClient.createSession(`AIBridge ${job.id}`, trigger.project_dir)
    await this.#jobManager.attachSession(job.id, session.id)
    await this.#opencodeClient.sendPromptAsync(session.id, trigger.prompt, trigger.project_dir)
    const running = await this.#jobManager.markRunning(job.id)

    await this.#taskGraphSyncer.syncJobToTask(resolvedTaskId, "running", {
      Job: job.id,
      Session: session.id,
    })

    void this.#monitorSession(running).catch(async (error: unknown) => {
      await this.#jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session monitor failed")
    })

    // Second durable write: acknowledge upon successful dispatch
    this.acknowledge(record.job_id, claimToken)
  }

  private async processReport(record: IngressRecord, claimToken: string): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(record.payload_json)
    } catch {
      this.fail(record.job_id, claimToken, "MALFORMED_JSON", Date.now())
      return
    }

    const parsed = reportCallbackSchema.safeParse(payload)
    if (!parsed.success) {
      this.fail(record.job_id, claimToken, "SCHEMA_VALIDATION_FAILED", Date.now())
      return
    }

    const report = parsed.data
    if (report.target_agent_id !== this.#config.agent_id) {
      this.fail(record.job_id, claimToken, "TARGET_AGENT_MISMATCH", Date.now())
      return
    }

    const source = this.#config.security.allowed_sources.find(
      (s) => s.source_agent_id === report.source_agent_id,
    )
    if (!source) {
      this.fail(record.job_id, claimToken, `SOURCE_UNAUTHORIZED_${report.source_agent_id}`, Date.now())
      return
    }

    const unblocked = await this.#jobManager.recordRemoteReport({
      source_agent_id: report.source_agent_id,
      job_id: report.job_id,
      status: report.status,
    })

    for (const unblockedJob of unblocked) {
      const recorded = this.#orchestration?.translation.recordReport(unblockedJob)
      if (recorded !== undefined && !recorded.ok) {
        throw new Error(recorded.error.message)
      }
      try {
        const session = await this.#opencodeClient.createSession(
          `AIBridge ${unblockedJob.id}`,
          unblockedJob.trigger.project_dir,
        )
        await this.#jobManager.attachSession(unblockedJob.id, session.id)
        await this.#opencodeClient.sendPromptAsync(
          session.id,
          unblockedJob.trigger.prompt,
          unblockedJob.trigger.project_dir,
        )
        const running = await this.#jobManager.markRunning(unblockedJob.id)
        void this.#monitorSession(running)
      } catch (err) {
        await this.#jobManager.markFailed(
          unblockedJob.id,
          err instanceof Error ? err.message : "Execution failed",
        )
      }
    }

    this.acknowledge(record.job_id, claimToken)
  }

  /**
   * Runs one drain cycle deterministically.
   * Recovers stale claims, claims ready rows, and processes them.
   */
  async drainOnce(nowMs = Date.now(), limit = 10): Promise<number> {
    this.recoverStale(nowMs)
    const { token, rows } = this.claim(nowMs, limit)
    for (const row of rows) {
      await this.processRecord(row, token, nowMs)
    }
    return rows.length
  }

  /**
   * Start polling loop.
   */
  start(intervalMs = 500): void {
    if (this.running) return
    this.running = true

    const poll = async () => {
      if (!this.running) return
      try {
        await this.drainOnce()
      } catch {
        // keep polling
      }
      if (this.running) {
        this.timer = setTimeout(poll, intervalMs)
      }
    }

    void poll()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

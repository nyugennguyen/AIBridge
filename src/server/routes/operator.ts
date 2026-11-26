/**
 * Operator endpoints (Phase 4 approval, Phase 7 kill switch).
 *
 *   POST /jobs/:id/approve        awaiting_approval -> launched on this node's runtime (exactly once; again -> 409)
 *   POST /jobs/:id/reject         awaiting_approval -> failed "rejected by operator", callback sent
 *   GET  /operator/pending-jobs   the jobs awaiting approval, with what an operator must see
 *   POST /operator/stop-all-jobs  terminates every running Claude/script job ("stopped by operator")
 *
 * Every route requires the OPERATOR credential and, by default, a request from
 * this host (`authorizeOperatorRequest`). The peer bearer is refused with 403:
 * a peer must never be able to approve its own work. Each decision is appended
 * to the approval ledger (ADR 0013) before it takes effect.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { JobRecord } from "../../jobs/types.js"
import { authorizeOperatorRequest } from "../../security/operator-auth.js"
import type { AppDependencies } from "../app.js"
import { atCapacityBody, launchClaudeJob, terminalReporter } from "./claude-dispatch.js"
import { dispatchOpencodeJob, settleFailedDispatch } from "./opencode-dispatch.js"

const rejectBodySchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .nullish()

export const REJECTED_BY_OPERATOR = "rejected by operator"

/** When an approval request lapses: the trigger's own `timeout_seconds` after it was created. */
export function approvalExpiresAt(job: JobRecord): string {
  return new Date(Date.parse(job.createdAt) + job.trigger.timeout_seconds * 1000).toISOString()
}

/** What `aibr jobs pending` and `aibr approve` show before asking. */
export function pendingJobView(job: JobRecord): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    capability: job.trigger.capability,
    source_agent_id: job.trigger.source_agent_id,
    project_dir: job.trigger.project_dir,
    prompt: job.trigger.prompt,
    ...(job.checkout !== undefined ? { repo: job.checkout.repo, ref: job.checkout.ref, sha: job.checkout.sha } : {}),
    created_at: job.createdAt,
    expires_at: approvalExpiresAt(job),
  }
}

export function registerOperatorRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  const report = terminalReporter(dependencies)
  // Optional chaining: a hand-built config object (tests, embedders) may predate the field.
  const runtimeKind = dependencies.config.runtime?.kind ?? "opencode"
  /** Job ids with a decision in flight: two concurrent approvals cannot both launch. */
  const deciding = new Set<string>()

  const guard = (request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined => {
    const decision = authorizeOperatorRequest(
      {
        config: dependencies.config,
        operatorToken: dependencies.operatorToken ?? null,
        ...(dependencies.localAddresses !== undefined ? { localAddresses: dependencies.localAddresses } : {}),
      },
      request,
    )
    return decision.ok ? undefined : reply.code(decision.statusCode).send(decision.body)
  }

  const ledger = async (event: Parameters<NonNullable<AppDependencies["approvalLedger"]>["append"]>[0]): Promise<void> => {
    await dependencies.approvalLedger?.append(event)
  }

  app.post<{ Params: { id: string } }>("/jobs/:id/approve", async (request, reply) => {
    const refused = guard(request, reply)
    if (refused !== undefined) return refused
    const jobId = request.params.id
    if (deciding.has(jobId)) return reply.code(409).send({ error: "A decision on this job is already in progress", code: "decision_in_progress" })
    deciding.add(jobId)
    try {
      let job: JobRecord
      try {
        job = await dependencies.jobManager.getJob(jobId)
      } catch {
        return reply.code(404).send({ error: "Job not found" })
      }
      if (job.status !== "awaiting_approval") {
        return reply.code(409).send({ error: `Job is not awaiting approval (status ${job.status})`, code: "not_awaiting_approval", status: job.status })
      }
      if (Date.now() > Date.parse(approvalExpiresAt(job))) {
        const expired = await dependencies.jobManager.markTimedOut(jobId)
        await ledger({ type: "approval.expired", jobId, reason: "approval window expired", actor: "operator", at: expired.updatedAt })
        await report(expired)
        return reply.code(409).send({ error: "The approval window for this job has expired", code: "approval_expired" })
      }
      // Runtime checks come BEFORE the decision is recorded: a full node or an
      // unhealthy OpenCode server leaves the job awaiting approval, so the
      // operator can simply retry.
      if (runtimeKind === "claude") {
        if (dependencies.claudeJobRunner === undefined) {
          return reply.code(503).send({ error: "Claude Code runtime is not available", code: "runtime_unavailable" })
        }
        if (dependencies.claudeJobRunner.hasCapacity?.() === false) return reply.code(429).send(atCapacityBody(dependencies))
      } else if (!(await dependencies.opencodeClient.health())) {
        return reply.code(503).send({ error: "OpenCode server unhealthy", code: "runtime_unavailable" })
      }

      // Ledger first: a decision that was not recorded must not take effect.
      const decidedAt = new Date().toISOString()
      await ledger({
        type: "approval.granted",
        jobId,
        capability: job.trigger.capability,
        sourceAgentId: job.trigger.source_agent_id,
        ...(job.checkout !== undefined ? { sha: job.checkout.sha } : {}),
        actor: "operator",
        at: decidedAt,
      })
      const approved = await dependencies.jobManager.approve(jobId, decidedAt)
      if (runtimeKind !== "claude") return await launchApprovedOpencodeJob(approved, reply)
      const launched = await launchClaudeJob(approved, dependencies, { reportFailure: true })
      if (!launched.ok) return reply.code(launched.statusCode).send(launched.body)
      return reply.code(200).send({
        job_id: jobId,
        status: launched.launch.job.status,
        ...(launched.launch.runtimeSessionId !== undefined ? { runtime_session_id: launched.launch.runtimeSessionId } : {}),
        ...(approved.checkout !== undefined ? { sha: approved.checkout.sha } : {}),
      })
    } finally {
      deciding.delete(jobId)
    }
  })

  /**
   * Starts an approved OpenCode job, or holds it `blocked` on unfinished
   * dependencies. A failure fails the job and delivers its report: the
   * original caller is waiting for a callback, not for this response.
   */
  const launchApprovedOpencodeJob = async (approved: JobRecord, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      const dispatched = await dispatchOpencodeJob(approved, dependencies, { recordInKernel: false })
      if (!dispatched.ok) {
        // Fails and reports the job at most once, or leaves it to its owner.
        await settleFailedDispatch(approved, dispatched, dependencies)
        return reply.code(dispatched.statusCode).send(dispatched.body)
      }
      return reply.code(200).send({
        job_id: approved.id,
        status: dispatched.job.status,
        ...(dispatched.sessionId !== undefined ? { opencode_session_id: dispatched.sessionId } : {}),
      })
    } catch (error) {
      const body = { error: error instanceof Error ? error.message : "OpenCode launch failed" }
      await settleFailedDispatch(approved, { body }, dependencies)
      return reply.code(500).send({ error: (await dependencies.jobManager.getJob(approved.id).catch(() => undefined))?.error ?? body.error })
    }
  }

  app.post<{ Params: { id: string } }>("/jobs/:id/reject", async (request, reply) => {
    const refused = guard(request, reply)
    if (refused !== undefined) return refused
    const body = rejectBodySchema.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: "Invalid reject payload", details: body.error.issues })
    const jobId = request.params.id
    if (deciding.has(jobId)) return reply.code(409).send({ error: "A decision on this job is already in progress", code: "decision_in_progress" })
    deciding.add(jobId)
    try {
      let job: JobRecord
      try {
        job = await dependencies.jobManager.getJob(jobId)
      } catch {
        return reply.code(404).send({ error: "Job not found" })
      }
      if (job.status !== "awaiting_approval") {
        return reply.code(409).send({ error: `Job is not awaiting approval (status ${job.status})`, code: "not_awaiting_approval", status: job.status })
      }
      const operatorReason = body.data?.reason
      const reason = operatorReason !== undefined ? `${REJECTED_BY_OPERATOR}: ${operatorReason}` : REJECTED_BY_OPERATOR
      const decidedAt = new Date().toISOString()
      await ledger({ type: "approval.rejected", jobId, reason, actor: "operator", at: decidedAt })
      const rejected = await dependencies.jobManager.reject(jobId, reason, decidedAt)
      await dependencies.taskGraphSyncer.syncJobToTask(rejected.trigger.task_id ?? `#${jobId}`, "failed").catch(() => undefined)
      await report(rejected)
      return reply.code(200).send({ job_id: jobId, status: rejected.status, error: reason })
    } finally {
      deciding.delete(jobId)
    }
  })

  app.get("/operator/pending-jobs", async (request, reply) => {
    const refused = guard(request, reply)
    if (refused !== undefined) return refused
    const jobs = (await dependencies.jobManager.listJobs())
      .filter((job) => job.status === "awaiting_approval")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return { jobs: jobs.map(pendingJobView) }
  })

  app.post("/operator/stop-all-jobs", async (request, reply) => {
    const refused = guard(request, reply)
    if (refused !== undefined) return refused
    const runner = dependencies.claudeJobRunner
    if (runner?.stopAll === undefined) return { stopped: [] }
    const stopped = await runner.stopAll()
    if (stopped.length > 0) {
      await ledger({ type: "jobs.stopped", jobIds: stopped, reason: "stopped by operator", actor: "operator", at: new Date().toISOString() })
    }
    return { stopped }
  })
}

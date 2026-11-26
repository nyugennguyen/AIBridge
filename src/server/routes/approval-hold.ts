/**
 * Holding a triggered job for an operator's approval, for every runtime.
 *
 * The job has already been created as `awaiting_approval`. This records the
 * request in the approval ledger (ADR 0013), marks its task blocked and
 * answers 202 with the command the operator runs on this node. Nothing runs
 * until `POST /jobs/:id/approve`.
 */
import type { FastifyReply } from "fastify"
import { triggerResponseSchema } from "../../config/schemas.js"
import type { JobRecord } from "../../jobs/types.js"
import type { AppDependencies } from "../app.js"
import { approveHint } from "./claude-dispatch.js"

export async function holdForApproval(
  job: JobRecord,
  rawBody: unknown,
  reply: FastifyReply,
  dependencies: AppDependencies,
  base: Record<string, unknown>,
): Promise<FastifyReply> {
  // Fail closed: an approval nobody can audit is not one this node holds.
  try {
    await dependencies.approvalLedger?.append({
      type: "approval.requested",
      jobId: job.id,
      capability: job.trigger.capability,
      sourceAgentId: job.trigger.source_agent_id,
      ...(job.checkout !== undefined ? { sha: job.checkout.sha } : {}),
      actor: "trigger",
      at: job.createdAt,
    })
  } catch (error) {
    const message = `Approval request could not be recorded: ${error instanceof Error ? error.message : "ledger error"}`
    await dependencies.jobManager.markFailed(job.id, message).catch(() => undefined)
    return reply.code(500).send({ error: message })
  }
  await dependencies.taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "blocked", { Job: job.id })
  dependencies.shadowMirror?.mirrorTrigger(rawBody, true)
  return reply.code(202).send(
    triggerResponseSchema.parse({
      ...base,
      status: "awaiting_approval",
      approve_hint: approveHint(job.id, dependencies.profileName),
    }),
  )
}

import type { FastifyInstance } from "fastify"
import { triggerRequestSchema, triggerResponseSchema } from "../../config/schemas.js"
import { BearerAuthProvider } from "../../security/auth-provider.js"
import { assertProjectAllowed } from "../../security/allowlist.js"
import { assertSourceAuthorized } from "../../security/source-authorization.js"
import { ConfigPlanReviewProvider } from "../../planning/provider.js"
import type { AppDependencies } from "../app.js"

export function registerTriggerRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  const auth = new BearerAuthProvider(dependencies.config.security.bearer_token)
  const planReview = new ConfigPlanReviewProvider(dependencies.config.planning.require_approval_for)

  app.post("/trigger", async (request, reply) => {
    if (!auth.validate(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" })

    const parsed = triggerRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid trigger payload", details: parsed.error.issues })
    const trigger = parsed.data

    if (trigger.target_agent_id !== dependencies.config.agent_id) return reply.code(404).send({ error: "Target agent not found here" })

    try {
      assertSourceAuthorized(trigger.source_agent_id, trigger.capability, dependencies.config.security.allowed_sources)
      assertProjectAllowed(trigger.project_dir, dependencies.config.projects)
      if (!planReview.isApproved(trigger.capability, trigger.metadata)) return reply.code(403).send({ error: "Plan approval required" })
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : "Forbidden" })
    }

    if (!(await dependencies.opencodeClient.health())) return reply.code(503).send({ error: "OpenCode server unhealthy" })

    try {
      const { depends_on, task_id, ...triggerData } = trigger
      const hasDeps = depends_on && depends_on.length > 0

      const depJobs = []
      if (hasDeps) {
        for (const depId of depends_on!) {
          try {
            depJobs.push(await dependencies.jobManager.getJob(depId))
          } catch {
            return reply.code(400).send({ error: `Dependency job not found: ${depId}` })
          }
        }
      }

      const job = await dependencies.jobManager.createJob(triggerData)
      const resolvedTaskId = task_id ?? `#${job.id}`

      if (hasDeps && !depJobs.every((dep) => dep.status === "completed")) {
        await dependencies.jobManager.markBlocked(job.id, depends_on!)
        await dependencies.taskGraphSyncer.syncJobToTask(resolvedTaskId, "blocked", { Job: job.id })

        return reply.code(202).send(
          triggerResponseSchema.parse({
            accepted: true,
            job_id: job.id,
            target_agent_id: dependencies.config.agent_id,
            status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
            status: "blocked",
            task_id: task_id,
          }),
        )
      }

      const session = await dependencies.opencodeClient.createSession(`AIBridge ${job.id}`, triggerData.project_dir)
      await dependencies.jobManager.attachSession(job.id, session.id)
      await dependencies.opencodeClient.sendPromptAsync(session.id, triggerData.prompt, triggerData.project_dir)
      const running = await dependencies.jobManager.markRunning(job.id)

      await dependencies.taskGraphSyncer.syncJobToTask(resolvedTaskId, "running", {
        Job: job.id,
        Session: session.id,
      })

      void dependencies.monitorSession(running).catch(async (error: unknown) => {
        await dependencies.jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session monitor failed")
      })

      return reply.code(202).send(
        triggerResponseSchema.parse({
          accepted: true,
          job_id: job.id,
          target_agent_id: dependencies.config.agent_id,
          opencode_session_id: session.id,
          status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
          status: "accepted",
          task_id: task_id,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trigger failed"
      if (message.includes("already exists")) return reply.code(409).send({ error: message })
      return reply.code(500).send({ error: message })
    }
  })
}

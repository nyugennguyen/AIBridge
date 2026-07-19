import type { FastifyInstance } from "fastify"
import { reportCallbackSchema } from "../../config/schemas.js"
import { BearerAuthProvider } from "../../security/auth-provider.js"
import type { AppDependencies } from "../app.js"

export function registerReportRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  const auth = new BearerAuthProvider(dependencies.bearerToken)

  app.post("/report", async (request, reply) => {
    if (!auth.validate(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" })
    const parsed = reportCallbackSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid report payload", details: parsed.error.issues })

    const report = parsed.data
    if (report.target_agent_id !== dependencies.config.agent_id) return reply.code(404).send({ error: "Target agent not found here" })
    const source = dependencies.config.security.allowed_sources.find(
      (candidate) => candidate.source_agent_id === report.source_agent_id,
    )
    if (!source) return reply.code(403).send({ error: `Source ${report.source_agent_id} is not authorized` })

    const unblocked = await dependencies.jobManager.recordRemoteReport({
      source_agent_id: report.source_agent_id,
      job_id: report.job_id,
      status: report.status,
    })
    for (const job of unblocked) {
      try {
        const session = await dependencies.opencodeClient.createSession(`AIBridge ${job.id}`, job.trigger.project_dir)
        await dependencies.jobManager.attachSession(job.id, session.id)
        await dependencies.opencodeClient.sendPromptAsync(session.id, job.trigger.prompt, job.trigger.project_dir)
        const running = await dependencies.jobManager.markRunning(job.id)
        void dependencies.monitorSession(running)
      } catch (error) {
        await dependencies.jobManager.markFailed(job.id, error instanceof Error ? error.message : "Execution failed")
      }
    }
    return reply.code(202).send({ accepted: true })
  })
}

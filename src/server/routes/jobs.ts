import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../app.js"

export function registerJobsRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    try {
      return await dependencies.jobManager.getJob(request.params.id)
    } catch {
      return reply.code(404).send({ error: "Job not found" })
    }
  })
}

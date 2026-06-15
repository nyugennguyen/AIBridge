import type { FastifyInstance } from "fastify"
import { reportCallbackSchema } from "../../config/schemas.js"
import type { AppDependencies } from "../app.js"

export function registerReportRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  app.post("/report", async (request, reply) => {
    const parsed = reportCallbackSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid report payload", details: parsed.error.issues })
    dependencies.reports.push(parsed.data)
    return reply.code(202).send({ accepted: true })
  })
}

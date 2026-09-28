import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../app.js"

export function registerJobsRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    let job
    try {
      job = await dependencies.jobManager.getJob(request.params.id)
    } catch {
      return reply.code(404).send({ error: "Job not found" })
    }

    // The legacy record is the answer, unchanged. The canonical correlation is
    // ADDED, never substituted: a caller that only knows the legacy id still
    // gets the same body it always did, and a caller that has adopted the
    // kernel can resolve the run without a second lookup.
    //
    // The correlation is derived from the stored record, not from a side table,
    // so it is correct for jobs written before the kernel was attached and
    // stable across restarts.
    const translation = dependencies.orchestration?.translation
    if (translation === undefined) return job

    const correlated = translation.correlate(job)
    if (!correlated.ok) {
      // A stored job the canonical model cannot represent is a diagnosable
      // condition, not a 404: the record exists, the mapping does not. Reporting
      // it as "not found" would hide a real data problem behind a plausible one.
      return reply.code(500).send({ error: correlated.error.message, code: correlated.error.code })
    }
    return { ...job, orchestration: { correlation: correlated.correlation } }
  })
}

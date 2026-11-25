import type { FastifyInstance } from "fastify"
import type { JobRecord } from "../../jobs/types.js"
import { legacyJobProjection } from "../../jobs/legacy-projection.js"
import type { AppDependencies } from "../app.js"

/**
 * The result fields a runtime-backed job adds to `GET /jobs/:id`.
 *
 * ADDED next to the stored record, never substituted for it: a caller that
 * reads `status`/`error` gets the body it always did. The fields only appear
 * once a runtime recorded a result (Claude Code jobs), so an OpenCode job's
 * body is byte-for-byte what it was. They are built from the persisted
 * `runtimeResult`, which the runner wrote from already-redacted adapter output
 * and which never holds a credential.
 */
export function jobResultFields(job: JobRecord): Record<string, unknown> {
  // The pinned commit is known from acceptance on, so it is shown before any result.
  const checkout = job.checkout !== undefined ? { repo: job.checkout.repo, ref: job.checkout.ref, sha: job.checkout.sha } : {}
  const result = job.runtimeResult
  if (result === undefined) return checkout
  return {
    ...checkout,
    summary: result.summary,
    findings: result.findings,
    artifacts: [],
    ...(result.usage?.totalCostUsd !== undefined ? { cost_usd: result.usage.totalCostUsd } : {}),
    ...(result.usage?.numTurns !== undefined ? { num_turns: result.usage.numTurns } : {}),
    ...(job.runtimeSessionId !== undefined ? { runtime_session_id: job.runtimeSessionId } : {}),
    ...(result.scriptResults !== undefined ? { script_results: result.scriptResults } : {}),
  }
}

export function registerJobsRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    let job
    try {
      job = await dependencies.jobManager.getJob(request.params.id)
    } catch {
      return reply.code(404).send({ error: "Job not found" })
    }
    const body = { ...job, ...jobResultFields(job) }

    // The legacy record is the answer, unchanged. The canonical correlation is
    // ADDED, never substituted: a caller that only knows the legacy id still
    // gets the same body it always did, and a caller that has adopted the
    // kernel can resolve the run without a second lookup.
    //
    // The correlation is derived from the stored record, not from a side table,
    // so it is correct for jobs written before the kernel was attached and
    // stable across restarts.
    const translation = dependencies.orchestration?.translation
    if (translation === undefined) return body

    const correlated = translation.correlate(legacyJobProjection(job))
    if (!correlated.ok) {
      // A stored job the canonical model cannot represent is a diagnosable
      // condition, not a 404: the record exists, the mapping does not. Reporting
      // it as "not found" would hide a real data problem behind a plausible one.
      return reply.code(500).send({ error: correlated.error.message, code: correlated.error.code })
    }
    return { ...body, orchestration: { correlation: correlated.correlation } }
  })
}

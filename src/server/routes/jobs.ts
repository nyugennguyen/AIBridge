import type { FastifyInstance } from "fastify"
import type { JobRecord } from "../../jobs/types.js"
import type { AppDependencies } from "../app.js"
import { callerMaySeeJob, createJobCallerIdentifier, NOT_JOB_REQUESTER } from "../job-caller.js"

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

/**
 * `GET /jobs/:id`: the stored job and its result. Until 3.2.0 it answered
 * anyone (threat model F-03). Who may read it now (`../job-caller.ts`):
 *
 * - the operator credential (rules of `aibr approve`): any job;
 * - a bearer holder whose request carries a verified node signature: only
 *   the jobs it dispatched (`trigger.source_agent_id`), else 403
 *   `not_job_requester`. This holds with `request_signing` "optional" and
 *   "required"; with "off" signatures are not verified at all, so a signed
 *   request is just a bearer request and reads any job (next point);
 * - a bearer holder with NO signature: any job, but only where this node does
 *   not ask for signatures (`request_signing` "off" or "optional"). There the
 *   shared bearer is the boundary already (it lets its holder trigger work
 *   as any allowed source), and an orchestrator that is not paired polls its
 *   results this way. With "required" the identity guard refuses it (401
 *   `signature_required`);
 * - anyone else: 401, before the job is looked up, so an unauthenticated
 *   caller cannot even learn whether an id exists.
 *
 * `auth_mode: "none"` admits every request as a bearer holder, as on `/trigger`.
 * The body an authorized caller gets is unchanged.
 */
export function registerJobsRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  const identify = createJobCallerIdentifier(dependencies)
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const identified = await identify(request)
    if (!identified.ok) return reply.code(identified.status).send(identified.body)
    let job
    try {
      job = await dependencies.jobManager.getJob(request.params.id)
    } catch {
      return reply.code(404).send({ error: "Job not found" })
    }
    if (identified.caller !== null && !callerMaySeeJob(identified.caller, job)) return reply.code(403).send(NOT_JOB_REQUESTER)
    return { ...job, ...jobResultFields(job) }
  })
}

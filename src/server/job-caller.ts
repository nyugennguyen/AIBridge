/**
 * Who is asking about a job: the one rule behind `GET /jobs`, `GET /jobs/:id`,
 * `GET /jobs/:id/events` and `POST /jobs/:id/cancel`.
 *
 * - The OPERATOR credential, under the same rules as `aibr approve`
 *   (`authorizeOperatorRequest`, including `approval_from_loopback_only`),
 *   sees every job on this node.
 * - A PEER holding the bearer AND a verified node signature (ADR 0012) sees
 *   only the jobs whose `trigger.source_agent_id` is the verified agent id.
 * - A peer holding the bearer with NO signature names nobody. Whether that is
 *   enough is the route's call: the job API (list, events, cancel) refuses it
 *   (403 `requester_identity_required`); `GET /jobs/:id` accepts it only where
 *   this node does not ask for signatures, see `routes/jobs.ts`.
 *
 * With `security.request_signing: "required"` an unsigned request never gets
 * this far: the identity guard answers 401 `signature_required` first.
 */
import type { FastifyRequest } from "fastify"
import type { JobRecord } from "../jobs/types.js"
import { requireIdentityGuard } from "../pairing/verifier.js"
import { bearerTokenMatches, createAuthProvider } from "../security/auth-provider.js"
import { authorizeOperatorRequest } from "../security/operator-auth.js"
import type { AppDependencies } from "./app.js"

export type JobCaller = { readonly kind: "operator" } | { readonly kind: "requester"; readonly agentId: string }

export type JobCallerRefusal = { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> }

/** `caller: null` is a bearer holder whose request carried no signature (only possible with signing "off" or "optional"). */
export type JobCallerIdentification = { readonly ok: true; readonly caller: JobCaller | null } | JobCallerRefusal

export const NOT_JOB_REQUESTER = { error: "This job was not dispatched by the caller", code: "not_job_requester" } as const

/**
 * Builds the identification for these routes. Built at registration, as on
 * `/trigger`: a misconfigured profile (bearer mode without a token, signing
 * without a guard) fails when the app is built.
 */
export function createJobCallerIdentifier(dependencies: AppDependencies): (request: FastifyRequest) => Promise<JobCallerIdentification> {
  const auth = createAuthProvider(dependencies.config.security.auth_mode, dependencies.bearerToken)
  const identity = requireIdentityGuard(dependencies.config.security.request_signing, dependencies.requestIdentity)
  return async (request) => {
    const authorization = request.headers.authorization
    const operatorToken = dependencies.operatorToken ?? null
    if (operatorToken !== null && operatorToken.length > 0 && bearerTokenMatches(authorization, operatorToken)) {
      const decision = authorizeOperatorRequest(
        {
          config: dependencies.config,
          operatorToken,
          ...(dependencies.localAddresses !== undefined ? { localAddresses: dependencies.localAddresses } : {}),
        },
        request,
      )
      return decision.ok ? { ok: true, caller: { kind: "operator" } } : { ok: false, status: decision.statusCode, body: decision.body }
    }
    if (!auth.validate(authorization)) return { ok: false, status: 401, body: { error: "Unauthorized" } }
    if (identity !== undefined) {
      const verified = await identity.check(request, undefined)
      if (!verified.ok) return { ok: false, status: verified.status, body: verified.body }
      if (verified.agentId !== null) return { ok: true, caller: { kind: "requester", agentId: verified.agentId } }
    }
    return { ok: true, caller: null }
  }
}

/** Whether `caller` may see `job`: the operator sees every job, a requester only its own. */
export function callerMaySeeJob(caller: JobCaller, job: JobRecord): boolean {
  return caller.kind === "operator" || job.trigger.source_agent_id === caller.agentId
}

import type { FastifyInstance, FastifyReply } from "fastify"
import { triggerRequestSchema, triggerResponseSchema } from "../../config/schemas.js"
import { createAuthProvider } from "../../security/auth-provider.js"
import { assertProjectAllowed } from "../../security/allowlist.js"
import { assertSourceAuthorized } from "../../security/source-authorization.js"
import { approvalRequired, callerClaimsPlanApproval } from "../../planning/approval.js"
import { authorizeClaudeCapability } from "../../runtime/claude-job-runner.js"
import { requireIdentityGuard } from "../../pairing/verifier.js"
import { GitRefNotFoundError, resolveConfiguredRepository } from "../../runtime/repo-workspace.js"
import type { JobCheckout } from "../../jobs/types.js"
import type { TriggerRequest } from "../../config/types.js"
import type { AppDependencies } from "../app.js"
import { atCapacityBody, launchClaudeJob, terminalReporter } from "./claude-dispatch.js"
import { holdForApproval } from "./approval-hold.js"
import { dispatchOpencodeJob } from "./opencode-dispatch.js"
import { PING_CAPABILITY, buildPong } from "../../jobs/ping.js"
import { CLI_VERSION } from "../../version.js"

export function registerTriggerRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  // Built at registration, not per request: a null token with `bearer-token` mode
  // throws here, so a misconfigured profile fails when the app is created rather
  // than on the first inbound request.
  const auth = createAuthProvider(
    dependencies.config.security.auth_mode,
    dependencies.bearerToken,
  )
  // Optional chaining: a hand-built config object (tests, embedders) may predate the field.
  const runtimeKind = dependencies.config.runtime?.kind ?? "opencode"

  // Phase 3 (ADR 0012): node signatures, after the bearer (defence in depth).
  const identity = requireIdentityGuard(dependencies.config.security.request_signing, dependencies.requestIdentity)

  app.post("/trigger", async (request, reply) => {
    if (!auth.validate(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" })
    if (identity !== undefined) {
      const verified = await identity.check(request, (request.body as { source_agent_id?: unknown } | null)?.source_agent_id)
      if (!verified.ok) return reply.code(verified.status).send(verified.body)
    }

    const parsed = triggerRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      dependencies.shadowMirror?.mirrorTrigger(request.body, false)
      return reply.code(400).send({ error: "Invalid trigger payload", details: parsed.error.issues })
    }
    const trigger = parsed.data

    if (trigger.target_agent_id !== dependencies.config.agent_id) return reply.code(404).send({ error: "Target agent not found here" })

    // Before 3.1.2 the OpenCode runtime took this caller-written field as an
    // approval. It no longer grants anything on any runtime; say so once per
    // request so a caller relying on it can see why its job is held.
    if (callerClaimsPlanApproval(trigger)) {
      request.log.warn(
        { source_agent_id: trigger.source_agent_id, capability: trigger.capability },
        'Ignoring metadata.plan_status "approved": only an operator on this node approves jobs (aibr approve)',
      )
    }

    // `aibr ping`: after the same authentication as any trigger, before anything
    // that would run work. See src/jobs/ping.ts.
    if (trigger.capability === PING_CAPABILITY) return await handlePing(trigger, reply, dependencies)

    try {
      assertSourceAuthorized(trigger.source_agent_id, trigger.capability, dependencies.config.security.allowed_sources)
      assertProjectAllowed(trigger.project_dir, dependencies.config.projects)
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : "Forbidden" })
    }

    if (runtimeKind === "claude") return await handleClaudeTrigger(trigger, request.body, reply, dependencies)

    if (trigger.repo !== undefined || trigger.ref !== undefined) {
      return reply
        .code(501)
        .send({ error: "repo/ref pinning is only implemented for runtime claude", code: "not_implemented" })
    }

    // Approval is decided from this node's config only, never from the
    // caller's `metadata.plan_status` (ADR 0013): a peer cannot approve itself.
    const holdForOperator = approvalRequired(dependencies.config, trigger)

    // A held job is not `blocked`, so a dependency's report that arrives while
    // it waits for the operator would be dropped, and the job would then block
    // forever. Refused rather than half-supported, as on the Claude runtime.
    if (holdForOperator && (trigger.depends_on ?? []).length > 0) {
      return reply.code(501).send({
        error: "depends_on is not implemented for jobs that need operator approval",
        code: "not_implemented",
      })
    }

    // An approval-held job never reaches OpenCode until it is approved, so the
    // server's health is checked at approval time instead.
    if (!holdForOperator && !(await dependencies.opencodeClient.health())) {
      return reply.code(503).send({ error: "OpenCode server unhealthy" })
    }

    try {
      const localDependencyIds = (trigger.depends_on ?? []).filter((dependency): dependency is string => typeof dependency === "string")
      for (const dependencyId of localDependencyIds) {
        try {
          await dependencies.jobManager.getJob(dependencyId)
        } catch {
          return reply.code(400).send({ error: `Dependency job not found: ${dependencyId}` })
        }
      }

      const job = await dependencies.jobManager.createJob(trigger, undefined, { awaitingApproval: holdForOperator })
      const base = {
        accepted: true,
        job_id: job.id,
        target_agent_id: dependencies.config.agent_id,
        status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
        task_id: trigger.task_id,
      }

      if (holdForOperator) return await holdForApproval(job, request.body, reply, dependencies, base)

      const dispatched = await dispatchOpencodeJob(job, dependencies)
      if (!dispatched.ok) return reply.code(dispatched.statusCode).send(dispatched.body)

      if (dispatched.status === "accepted") dependencies.shadowMirror?.mirrorTrigger(request.body, true)
      return reply.code(202).send(
        triggerResponseSchema.parse({
          ...base,
          ...(dispatched.sessionId !== undefined ? { opencode_session_id: dispatched.sessionId } : {}),
          status: dispatched.status,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trigger failed"
      if (message.includes("already exists")) return reply.code(409).send({ error: message })
      return reply.code(500).send({ error: message })
    }
  })
}

/**
 * `/trigger` for `runtime.kind: "claude"`, after the shared bearer, source and
 * project allowlist checks. OpenCode is never contacted on this path.
 *
 * Order: capability profile -> unsupported features -> concurrency (jobs that
 * run now) -> repository pinning (resolve `repo`@`ref` to a sha, so an
 * operator approves an exact commit, not a moving branch) -> create the job,
 * held as `awaiting_approval` when this node's config requires an operator ->
 * record it in the kernel -> launch, or record the approval request.
 */
async function handleClaudeTrigger(
  trigger: TriggerRequest,
  rawBody: unknown,
  reply: FastifyReply,
  dependencies: AppDependencies,
): Promise<FastifyReply> {
  const decision = authorizeClaudeCapability(dependencies.config, trigger)
  if (!decision.ok) return reply.code(decision.statusCode).send(decision.body)

  const dependencyReferences = trigger.depends_on ?? []
  if (dependencyReferences.length > 0) {
    // Unblocking a dependent launches it from the OpenCode monitor and the
    // `/report` route; neither knows the Claude runner yet.
    return reply
      .code(501)
      .send({ error: "depends_on is not implemented for runtime claude", code: "not_implemented" })
  }

  const runner = dependencies.claudeJobRunner
  if (runner === undefined) {
    return reply.code(503).send({ error: "Claude Code runtime is not available", code: "runtime_unavailable" })
  }
  if (trigger.ref !== undefined && trigger.repo === undefined) {
    return reply.code(400).send({ error: "ref requires repo", code: "ref_requires_repo" })
  }
  // Honest, not queued: a peer is told the node is full and retries.
  if (!decision.approvalRequired && runner.hasCapacity?.() === false) {
    return reply.code(429).send(atCapacityBody(dependencies))
  }

  let checkout: JobCheckout | undefined
  if (trigger.repo !== undefined) {
    const repository = resolveConfiguredRepository(dependencies.config, trigger.repo)
    if (repository === undefined) {
      return reply
        .code(403)
        .send({ error: "Repository is not configured on this node", code: "repository_not_allowed" })
    }
    if (dependencies.repoWorkspaces === undefined) {
      return reply.code(503).send({ error: "Repository checkouts are not available on this node", code: "workspaces_unavailable" })
    }
    const ref = trigger.ref ?? repository.defaultRef
    try {
      checkout = { repo: repository.name, ref, sha: await dependencies.repoWorkspaces.resolveSha(repository, ref) }
    } catch (error) {
      if (error instanceof GitRefNotFoundError) return reply.code(400).send({ error: error.message, code: error.code })
      const message = error instanceof Error ? error.message : "git failed"
      return reply.code(502).send({ error: message, code: "git_failed" })
    }
  }

  let job
  try {
    job = await dependencies.jobManager.createJob(trigger, undefined, {
      awaitingApproval: decision.approvalRequired,
      ...(checkout !== undefined ? { checkout } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger failed"
    if (message.includes("already exists")) return reply.code(409).send({ error: message })
    return reply.code(500).send({ error: message })
  }

  const base = {
    accepted: true,
    job_id: job.id,
    target_agent_id: dependencies.config.agent_id,
    status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
    task_id: trigger.task_id,
    ...(checkout !== undefined ? { sha: checkout.sha } : {}),
  }

  if (decision.approvalRequired) return await holdForApproval(job, rawBody, reply, dependencies, base)

  const launched = await launchClaudeJob(job, dependencies, { reportFailure: false })
  if (!launched.ok) return reply.code(launched.statusCode).send(launched.body)

  dependencies.shadowMirror?.mirrorTrigger(rawBody, true)
  return reply.code(202).send(
    triggerResponseSchema.parse({
      ...base,
      ...(launched.launch.runtimeSessionId !== undefined ? { runtime_session_id: launched.launch.runtimeSessionId } : {}),
      status: "accepted",
    }),
  )
}

/**
 * A no-op job: the caller is an enrolled source, nothing runs, the job is
 * completed at once and reported back through the normal callback path.
 */
async function handlePing(trigger: TriggerRequest, reply: FastifyReply, dependencies: AppDependencies): Promise<FastifyReply> {
  const source = dependencies.config.security.allowed_sources.find((s) => s.source_agent_id === trigger.source_agent_id)
  if (source === undefined) {
    return reply.code(403).send({ error: `Source ${trigger.source_agent_id} is not authorized`, code: "source_not_enrolled" })
  }
  if (trigger.repo !== undefined || trigger.ref !== undefined || (trigger.depends_on ?? []).length > 0) {
    return reply.code(400).send({ error: "A ping takes no repo, ref or depends_on", code: "invalid_ping" })
  }
  let job
  try {
    job = await dependencies.jobManager.createJob(trigger)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger failed"
    if (message.includes("already exists")) return reply.code(409).send({ error: message })
    return reply.code(500).send({ error: message })
  }
  const completed = await dependencies.jobManager.completePing(
    job.id,
    buildPong(dependencies.config, trigger.source_agent_id, CLI_VERSION),
  )
  // Delivered after the answer, like every finished job: the caller learns the
  // delivery outcome from `GET /jobs/:id` (`callbackDelivery`). Never throws.
  void terminalReporter(dependencies)(completed)
  return reply.code(202).send(
    triggerResponseSchema.parse({
      accepted: true,
      job_id: job.id,
      target_agent_id: dependencies.config.agent_id,
      status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
      status: "accepted",
      ...(trigger.task_id !== undefined ? { task_id: trigger.task_id } : {}),
    }),
  )
}

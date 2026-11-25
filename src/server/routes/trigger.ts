import type { FastifyInstance, FastifyReply } from "fastify"
import { triggerRequestSchema, triggerResponseSchema } from "../../config/schemas.js"
import { createAuthProvider } from "../../security/auth-provider.js"
import { assertProjectAllowed } from "../../security/allowlist.js"
import { assertSourceAuthorized } from "../../security/source-authorization.js"
import { ConfigPlanReviewProvider } from "../../planning/provider.js"
import { authorizeClaudeCapability } from "../../runtime/claude-job-runner.js"
import { GitRefNotFoundError, resolveConfiguredRepository } from "../../runtime/repo-workspace.js"
import { legacyJobProjection } from "../../jobs/legacy-projection.js"
import type { JobCheckout } from "../../jobs/types.js"
import type { TriggerRequest } from "../../config/types.js"
import type { AppDependencies } from "../app.js"
import { approveHint, atCapacityBody, launchClaudeJob } from "./claude-dispatch.js"

export function registerTriggerRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  // Built at registration, not per request: a null token with `bearer-token` mode
  // throws here, so a misconfigured profile fails when the app is created rather
  // than on the first inbound request.
  const auth = createAuthProvider(
    dependencies.config.security.auth_mode,
    dependencies.bearerToken,
  )
  const planReview = new ConfigPlanReviewProvider(dependencies.config.planning.require_approval_for)
  // Optional chaining: a hand-built config object (tests, embedders) may predate the field.
  const runtimeKind = dependencies.config.runtime?.kind ?? "opencode"

  app.post("/trigger", async (request, reply) => {
    if (!auth.validate(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" })

    const parsed = triggerRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      dependencies.shadowMirror?.mirrorTrigger(request.body, false)
      return reply.code(400).send({ error: "Invalid trigger payload", details: parsed.error.issues })
    }
    const trigger = parsed.data

    if (trigger.target_agent_id !== dependencies.config.agent_id) return reply.code(404).send({ error: "Target agent not found here" })

    try {
      assertSourceAuthorized(trigger.source_agent_id, trigger.capability, dependencies.config.security.allowed_sources)
      assertProjectAllowed(trigger.project_dir, dependencies.config.projects)
      // The Claude runtime does not trust the caller-written `metadata.plan_status`;
      // its approval gate is `authorizeClaudeCapability` below.
      if (runtimeKind !== "claude" && !planReview.isApproved(trigger.capability, trigger.metadata)) {
        return reply.code(403).send({ error: "Plan approval required" })
      }
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : "Forbidden" })
    }

    if (runtimeKind === "claude") return await handleClaudeTrigger(trigger, request.body, reply, dependencies)

    if (trigger.repo !== undefined || trigger.ref !== undefined) {
      return reply
        .code(501)
        .send({ error: "repo/ref pinning is only implemented for runtime claude", code: "not_implemented" })
    }

    if (!(await dependencies.opencodeClient.health())) return reply.code(503).send({ error: "OpenCode server unhealthy" })

    try {
      const { depends_on, task_id, ...triggerData } = trigger
      const dependencyReferences = depends_on ?? []
      const localDependencyIds = dependencyReferences.filter((dependency): dependency is string => typeof dependency === "string")
      const hasDeps = dependencyReferences.length > 0

      const depJobs = []
      if (localDependencyIds.length > 0) {
        for (const depId of localDependencyIds) {
          try {
            depJobs.push(await dependencies.jobManager.getJob(depId))
          } catch {
            return reply.code(400).send({ error: `Dependency job not found: ${depId}` })
          }
        }
      }

      const job = await dependencies.jobManager.createJob(trigger)
      const resolvedTaskId = task_id ?? `#${job.id}`

      const hasRemoteDependencies = localDependencyIds.length !== dependencyReferences.length
      if (hasDeps && (hasRemoteDependencies || !depJobs.every((dep) => dep.status === "completed"))) {
        const blocked = await dependencies.jobManager.markBlocked(job.id, dependencyReferences)

        // A blocked job is still ACCEPTED work, so the kernel records it. It
        // maps to a paused draft run and names no launch effect: the job must not
        // reach a runtime until its dependencies are satisfied.
        const blockedAcceptance = dependencies.orchestration?.translation?.acceptTrigger(blocked)
        if (blockedAcceptance !== undefined && !blockedAcceptance.ok) {
          await dependencies.jobManager.markFailed(job.id, blockedAcceptance.error.message)
          return reply.code(500).send({ error: blockedAcceptance.error.message, code: blockedAcceptance.error.code })
        }
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

      // M4-A. The kernel is asked to record the accepted intent FIRST, and that
      // is all it is asked to do. It returns no launch effect, so there is
      // nothing here to acknowledge and nothing the kernel has vouched for: the
      // `createSession`/`sendPromptAsync` pair below is the RELEASED legacy
      // behaviour, authorized by this route's own bearer, source/capability,
      // allowlist and plan-review checks. It is deliberately not canonical work,
      // which is why the recorded run stays a DRAFT+PAUSED run holding a PENDING
      // task — the canonical record honestly shows that nothing canonical is
      // running, and if this work is to run canonically an operator must approve
      // it through `dispatch.propose` -> `dispatch.approve` -> `dispatch.execute`.
      // Before M4-A this call returned a named `legacy.runtime.launch` outbox
      // record carrying the route's checks as an `authorization` block, which
      // was threat-model finding F-05: integrity standing in for authenticity.
        const acceptance = dependencies.orchestration?.translation?.acceptTrigger(job)
      if (acceptance !== undefined && !acceptance.ok) {
        // Fail closed: the legacy job exists in the JSON store but the kernel
        // cannot account for it. Reporting 202 here would tell the caller work
        // started when the canonical record does not exist, so the job is
        // failed with a diagnosable message instead.
        await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
        return reply.code(500).send({ error: acceptance.error.message, code: acceptance.error.code })
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

      dependencies.shadowMirror?.mirrorTrigger(request.body, true)
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

  // Same kernel seam as the OpenCode path: record the accepted intent first,
  // and fail closed if the kernel cannot account for it. A held job is, to the
  // kernel, the same held DRAFT/PAUSED run every legacy trigger records.
  const acceptance = dependencies.orchestration?.translation?.acceptTrigger(legacyJobProjection(job))
  if (acceptance !== undefined && !acceptance.ok) {
    await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
    return reply.code(500).send({ error: acceptance.error.message, code: acceptance.error.code })
  }

  const base = {
    accepted: true,
    job_id: job.id,
    target_agent_id: dependencies.config.agent_id,
    status_url: `${dependencies.config.bridge.public_url}/jobs/${job.id}`,
    task_id: trigger.task_id,
    ...(checkout !== undefined ? { sha: checkout.sha } : {}),
  }

  if (decision.approvalRequired) {
    // Fail closed: an approval nobody can audit is not one this node holds.
    try {
      await dependencies.approvalLedger?.append({
        type: "approval.requested",
        jobId: job.id,
        capability: trigger.capability,
        sourceAgentId: trigger.source_agent_id,
        ...(checkout !== undefined ? { sha: checkout.sha } : {}),
        actor: "trigger",
        at: job.createdAt,
      })
    } catch (error) {
      const message = `Approval request could not be recorded: ${error instanceof Error ? error.message : "ledger error"}`
      await dependencies.jobManager.markFailed(job.id, message).catch(() => undefined)
      return reply.code(500).send({ error: message })
    }
    await dependencies.taskGraphSyncer.syncJobToTask(trigger.task_id ?? `#${job.id}`, "blocked", { Job: job.id })
    dependencies.shadowMirror?.mirrorTrigger(rawBody, true)
    return reply.code(202).send(
      triggerResponseSchema.parse({
        ...base,
        status: "awaiting_approval",
        approve_hint: approveHint(job.id, dependencies.profileName),
      }),
    )
  }

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

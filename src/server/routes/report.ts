import type { FastifyInstance } from "fastify"
import { reportCallbackSchema } from "../../config/schemas.js"
import { createAuthProvider } from "../../security/auth-provider.js"
import { requireIdentityGuard } from "../../pairing/verifier.js"
import { startOpencodeSession } from "../../opencode/launch.js"
import type { AppDependencies } from "../app.js"
import { terminalReporter } from "./claude-dispatch.js"

export function registerReportRoute(app: FastifyInstance, dependencies: AppDependencies): void {
  const auth = createAuthProvider(
    dependencies.config.security.auth_mode,
    dependencies.bearerToken,
  )

  // Phase 3 (ADR 0012): the reporting worker signs; its verified id must be
  // the report's `source_agent_id`.
  const identity = requireIdentityGuard(dependencies.config.security.request_signing, dependencies.requestIdentity)

  app.post("/report", async (request, reply) => {
    if (!auth.validate(request.headers.authorization)) return reply.code(401).send({ error: "Unauthorized" })
    if (identity !== undefined) {
      const verified = await identity.check(request, (request.body as { source_agent_id?: unknown } | null)?.source_agent_id)
      if (!verified.ok) return reply.code(verified.status).send(verified.body)
    }
    const parsed = reportCallbackSchema.safeParse(request.body)
    if (!parsed.success) {
      dependencies.shadowMirror?.mirrorReport(request.body, false)
      return reply.code(400).send({ error: "Invalid report payload", details: parsed.error.issues })
    }

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
      // A report is an observation, not an authority: recording it must not
      // fabricate a canonical lifecycle event, so the translation only
      // correlates the job and names any launch it owes.
      const recorded = dependencies.orchestration?.translation?.recordReport(job)
      if (recorded !== undefined && !recorded.ok) {
        return reply.code(500).send({ error: recorded.error.message, code: recorded.error.code })
      }
      try {
        const { running } = await startOpencodeSession(job, { ...dependencies, reportTerminalJob: terminalReporter(dependencies) })
        void dependencies.monitorSession(running)
      } catch {
        // OpenCode refused: the job is already failed and reported. The marker
        // refused: another path owns this job; leave it alone.
      }
    }
    dependencies.shadowMirror?.mirrorReport(request.body, true)
    return reply.code(202).send({ accepted: true })
  })
}

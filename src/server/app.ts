import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import type { BridgeConfig } from "../config/types.js"
import type { JobRecord } from "../jobs/types.js"
import type { JobManager } from "../jobs/manager.js"
import type { OpencodeClient } from "../opencode/types.js"
import type { CallbackReporter } from "../callback/reporter.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import { registerHealthRoute } from "./routes/health.js"
import { registerJobsRoute } from "./routes/jobs.js"
import { registerReportRoute } from "./routes/report.js"
import { registerTriggerRoute } from "./routes/trigger.js"

export interface AppDependencies {
  config: BridgeConfig
  jobManager: JobManager
  opencodeClient: OpencodeClient
  callbackReporter: CallbackReporter
  monitorSession: (job: JobRecord) => Promise<void>
  taskGraphSyncer: TaskGraphSyncer
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_048_576, logger: false })
  registerHealthRoute(app, dependencies)
  registerTriggerRoute(app, dependencies)
  registerJobsRoute(app, dependencies)
  registerReportRoute(app, dependencies)
  return app
}

import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import type { BridgeConfig } from "../config/types.js"
import type { JobRecord } from "../jobs/types.js"
import type { JobManager } from "../jobs/manager.js"
import type { OpencodeClient } from "../opencode/types.js"
import type { CallbackReporter } from "../callback/reporter.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import type { LegacyTranslation } from "../orchestration/legacy/translation.js"
import { registerHealthRoute } from "./routes/health.js"
import { registerJobsRoute } from "./routes/jobs.js"
import { registerReportRoute } from "./routes/report.js"
import { registerTriggerRoute } from "./routes/trigger.js"
import type { ShadowIngressMirror } from "./shadow.js"

export interface AppDependencies {
  config: BridgeConfig
  /**
   * The shared bearer secret, or `null` when the profile runs with
   * `security.auth_mode: "none"`.
   *
   * Nullable by design rather than by omission: it is read from a secret file that
   * `aibr setup` declines to write in `none` mode, and a caller holding `""` would
   * be indistinguishable from a caller holding no opinion. The routes resolve this
   * against `config.security.auth_mode` through `createAuthProvider`, which fails
   * closed if the two disagree.
   */
  bearerToken: string | null
  jobManager: JobManager
  opencodeClient: OpencodeClient
  callbackReporter: CallbackReporter
  monitorSession: (job: JobRecord) => Promise<void>
  taskGraphSyncer: TaskGraphSyncer
  shadowMirror?: ShadowIngressMirror
  /**
   * The orchestration kernel's legacy compatibility seam.
   *
   * Optional by design, not by omission: an absent block is the RELEASED
   * behaviour (the JSON store is the only state), while a present one records
   * each accepted trigger in the event log before the runtime is launched. Both
   * modes must serve an identical HTTP contract, so the routes branch only on
   * whether work was NAMED, never on whether work was silently dropped.
   */
  orchestration?: {
    readonly translation: LegacyTranslation
  }
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_048_576, logger: false })
  registerHealthRoute(app, dependencies)
  registerTriggerRoute(app, dependencies)
  registerJobsRoute(app, dependencies)
  registerReportRoute(app, dependencies)
  return app
}

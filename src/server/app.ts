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
import { registerJobApiRoutes, type JobEventStreamLimits } from "./routes/job-api.js"
import type { JobEventLog } from "../jobs/events.js"
import { registerReportRoute } from "./routes/report.js"
import { registerTriggerRoute } from "./routes/trigger.js"
import type { ShadowIngressMirror } from "./shadow.js"
import type { ClaudeJobRunner } from "../runtime/claude-job-runner.js"
import { registerEnrollRoute } from "./routes/enroll.js"
import type { RequestIdentityGuard } from "../pairing/verifier.js"
import type { PairingAcceptor } from "../pairing/service.js"
import type { RepoWorkspaceManager } from "../runtime/repo-workspace.js"
import { InMemoryApprovalLedger, type ApprovalLedger } from "../jobs/approval-ledger.js"
import { registerOperatorRoutes } from "./routes/operator.js"

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
  /**
   * The operator credential, or `null` when none is configured.
   *
   * The shared bearer secret admits PEERS (machine-to-machine callers); it
   * carries no per-caller identity, so on its own it cannot distinguish a human
   * operator from a peer agent. Operator actions (approve, reject, the kill
   * switch) and reading any job therefore rest on this second secret: an
   * authenticated state, not a self-asserted payload field (ADR 0008 §4,
   * ADR 0013). `null` fail-closes that authority.
   */
  operatorToken?: string | null
  jobManager: JobManager
  opencodeClient: OpencodeClient
  callbackReporter: CallbackReporter
  monitorSession: (job: JobRecord) => Promise<void>
  /**
   * Executes `/trigger` jobs when `config.runtime.kind` is `claude`. Absent on
   * an OpenCode node; a Claude node without one answers 503 rather than
   * falling back to OpenCode.
   */
  claudeJobRunner?: Pick<ClaudeJobRunner, "start" | "monitor"> &
    Partial<Pick<ClaudeJobRunner, "hasCapacity" | "stopAll" | "stop" | "isActive">>
  /**
   * What `GET /jobs/:id/events` reads. Absent: the job manager's own log
   * (`JobManager.eventLog`), else an empty in-memory one.
   */
  jobEvents?: JobEventLog
  /** How often an SSE stream re-reads the log when no event was pushed. Default 1 s; tests shorten it. */
  jobEventPollMs?: number
  /** Caps on open `GET /jobs/:id/events` SSE streams (global 64, per caller 8, per job 16 by default). */
  jobEventStreamLimits?: Partial<JobEventStreamLimits>
  /** How long `POST /jobs/:id/cancel` waits for the runner to end the job before answering 202. Default 15 s. */
  cancelStopWaitMs?: number
  /** The bridge log (`aibr logs`). Cancels are recorded here with the caller. Absent: not logged. */
  log?: (level: "info" | "warn" | "error", message: string) => void
  /**
   * Resolves a trigger's `repo` + `ref` to a pinned sha (Phase 5). Absent: a
   * trigger naming a `repo` is answered 503.
   */
  repoWorkspaces?: Pick<RepoWorkspaceManager, "resolveSha">
  /**
   * Audit log of approval requests, operator decisions and kill-switch use
   * (ADR 0013). Absent: an in-memory ledger (tests); `startBridge` always
   * supplies the file-backed one.
   */
  approvalLedger?: ApprovalLedger
  /** Delivers the report of a job an operator ended (reject / expiry). Defaults to one built from `callbackReporter`. */
  reportTerminalJob?: (job: JobRecord) => Promise<void>
  /** The profile this bridge serves; only used to print an exact `aibr approve` hint. */
  profileName?: string
  /** This host's own addresses, for the operator endpoints' same-host check. Injectable for tests. */
  localAddresses?: () => ReadonlySet<string>
  taskGraphSyncer: TaskGraphSyncer
  shadowMirror?: ShadowIngressMirror
  /**
   * Phase 3 (ADR 0012): verifies ed25519 node signatures on `/trigger` and
   * `/report`. Required when `security.request_signing` is not `off`; one
   * instance is shared by both routes so they share one replay guard.
   */
  readonly requestIdentity?: RequestIdentityGuard
  /** Serves `POST /enroll` (pairing) when present. */
  readonly pairing?: PairingAcceptor
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_048_576, logger: false })
  // One ledger for the trigger route (approval requested) and the operator
  // routes (decisions), so the chain is a single sequence.
  if (dependencies.approvalLedger === undefined) dependencies = { ...dependencies, approvalLedger: new InMemoryApprovalLedger() }
  registerHealthRoute(app, dependencies)
  registerTriggerRoute(app, dependencies)
  registerJobsRoute(app, dependencies)
  registerJobApiRoutes(app, dependencies)
  registerReportRoute(app, dependencies)
  registerEnrollRoute(app, dependencies)
  registerOperatorRoutes(app, dependencies)
  return app
}

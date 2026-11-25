import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import type { BridgeConfig } from "../config/types.js"
import type { JobRecord } from "../jobs/types.js"
import type { JobManager } from "../jobs/manager.js"
import type { OpencodeClient } from "../opencode/types.js"
import type { CallbackReporter } from "../callback/reporter.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import type { LegacyTranslation } from "../orchestration/legacy/translation.js"
import type { OrchestrationCommand } from "../orchestration/types.js"
import type { CoordinatorResult } from "../orchestration/coordinator/types.js"
import { registerHealthRoute } from "./routes/health.js"
import { registerJobsRoute } from "./routes/jobs.js"
import { registerReportRoute } from "./routes/report.js"
import { registerTriggerRoute } from "./routes/trigger.js"
import { registerOrchestrationRoutes } from "./routes/orchestration.js"
import type { ShadowIngressMirror } from "./shadow.js"
import type { ClaudeJobRunner } from "../runtime/claude-job-runner.js"
import { registerEnrollRoute } from "./routes/enroll.js"
import type { RequestIdentityGuard } from "../pairing/verifier.js"
import type { PairingAcceptor } from "../pairing/service.js"
import type { RepoWorkspaceManager } from "../runtime/repo-workspace.js"
import { InMemoryApprovalLedger, type ApprovalLedger } from "../jobs/approval-ledger.js"
import { registerOperatorRoutes } from "./routes/operator.js"
import type {
  NotificationBus,
  NotificationStore,
  OrchestrationNotificationConsumer,
} from "../notifications/index.js"

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
   * operator from a peer agent. User-kind `actor` claims (charter approval and
   * direct revision authority) therefore rest on this second secret: an
   * authenticated state, not a self-asserted payload field (ADR 0008 §4).
   * `null` fail-closes the authority: no caller may claim `kind: "user"`.
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
  claudeJobRunner?: Pick<ClaudeJobRunner, "start" | "monitor"> & Partial<Pick<ClaudeJobRunner, "hasCapacity" | "stopAll">>
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
   * The orchestration kernel's legacy compatibility seam.
   *
   * Optional by design, not by omission: an absent block is the RELEASED
   * behaviour (the JSON store is the only state), while a present one records
   * each accepted trigger in the event log before the runtime is launched. Both
   * modes must serve an identical HTTP contract, so the routes branch only on
   * whether work was NAMED, never on whether work was silently dropped.
   */
  orchestration?: {
    readonly translation?: LegacyTranslation
    readonly coordinator?: {
      submit(
        command: OrchestrationCommand,
      ): Promise<CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>> | CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>
      submitPrompt?(
        command: Extract<OrchestrationCommand, { type: "session.prompt" }>,
      ): Promise<CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>>
    }
  }
  readonly notificationStore?: NotificationStore
  readonly notificationBus?: NotificationBus
  readonly notificationConsumer?: OrchestrationNotificationConsumer
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
  registerReportRoute(app, dependencies)
  registerOrchestrationRoutes(app, dependencies)
  registerEnrollRoute(app, dependencies)
  registerOperatorRoutes(app, dependencies)
  return app
}

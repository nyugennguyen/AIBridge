/**
 * Wiring for `aibr worker --ipc-publish`: the publisher, the queue bridge, and a
 * world view built from the engine.
 *
 * ## Why these are three things and not one
 *
 * [`QueueBridge`] exists only because of a late-binding problem, and solving it any
 * other way would have been worse. The drainer needs its observer at construction
 * time; the publisher needs the drainer to exist first. Rather than reorder the
 * worker's startup or reach for a mutable global, the bridge is a small object
 * created empty and attached to once -- so a queue event that fires before the
 * socket is listening is dropped rather than buffered, which is the right thing to
 * do for a UI that is about to be told the queue's state in its opening snapshot
 * anyway.
 *
 * ## What the world view may and may not do
 *
 * {@link EngineWorldSource} READS. It reads the configured projects and the job
 * store and maps them onto the shapes `src/ipc/schemas.ts` declares. It never
 * decides anything: ADR 0008 §2.2 makes this process the sole authority for
 * authorization, and a second copy of "what state is this job in" would be a second
 * authority wearing a different hat. The one mutation it performs is `cancelJob`,
 * and that goes through the same `JobManager` the drainer uses rather than reaching
 * for a job file.
 */

import type { BridgeConfig } from "../config/types.js"
import type { JobManager } from "../jobs/manager.js"
import type { JobRecord } from "../jobs/types.js"
import type { IngressLifecycleObserver, IngressRecord } from "../ingress/drainer.js"
import { nodeIdSchema, projectIdSchema, sessionIdSchema } from "../orchestration/identifiers.js"
import { redactString } from "../observability/redaction.js"
import type {
  IpcJobState,
  IpcJobView,
  IpcPaneView,
  IpcTailscaleStatusView,
  IpcWorkspaceView,
} from "./schemas.js"
import { IpcPublisher, type IpcWorldSource, type PaneController } from "./publisher.js"

/**
 * Map a job store status onto the four states the bus publishes.
 *
 * A function rather than a cast because the two vocabularies are NOT the same and
 * the difference is load-bearing. `received`, `accepted` and `session_created` all
 * mean the engine has admitted work and dispatched it, which is `working` as far as
 * an operator watching a sidebar is concerned; defaulting them to `idle` would be
 * the safe-looking answer and the wrong one, reporting an agent as sitting at a
 * prompt while it is mid-run.
 */
function jobStateOf(job: JobRecord): IpcJobState {
  switch (job.status) {
    case "blocked":
      return "blocked"
    case "completed":
    case "failed":
    case "timed_out":
    case "callback_failed":
      // Terminal. `done` is the only terminal state the wire has, and `idle` would
      // be a lie: the job is over, not ready for more.
      return "done"
    case "running":
    case "accepted":
    case "session_created":
    case "received":
      return "working"
    default:
      // Unreachable for every status `JobRecord` declares, and a default rather than
      // an exhaustive `never` check so that ADDING a status to the store cannot fail
      // this build: a new status is far more likely to be another in-progress state
      // than a new wire state, and the wire's four are exhaustive by design.
      return "idle"
  }
}

/** Why a job is blocked, from what it is waiting on.
 *
 * Derived rather than carried, because the store records the DEPENDENCIES and not
 * the reason: a job blocked on unfinished predecessors is a dependency wait, and
 * one blocked inside OpenCode's permission prompt is a permission. Reporting
 * `plan_review` for both would open the approval modal for a job nobody is asking
 * to approve anything.
 */
function blockedReasonOf(job: JobRecord): IpcJobView["blockedReason"] {
  if (job.status !== "blocked") return null
  const waiting = (job.depends_on ?? []).length > 0 || (job.remoteDependencies ?? []).length > 0
  return waiting ? "plan_review" : "permission"
}

/** The engine, read through the shapes the bus publishes. */
export class EngineWorldSource implements IpcWorldSource {
  readonly #config: BridgeConfig
  readonly #jobManager: JobManager
  readonly #outboxPendingCount: () => number
  readonly #customSecrets: readonly string[]
  #selectedWorkspaceId: string | null

  constructor(options: {
    readonly config: BridgeConfig
    readonly jobManager: JobManager
    readonly outboxPendingCount: () => number
    readonly customSecrets?: readonly string[]
  }) {
    this.#config = options.config
    this.#jobManager = options.jobManager
    this.#outboxPendingCount = options.outboxPendingCount
    this.#customSecrets = options.customSecrets ?? []
    this.#selectedWorkspaceId = options.config.projects[0]?.id ?? null
  }

  /** The workspace the engine considers current.
   *
   * Starts at the first configured project rather than at nothing: an operator who
   * has not chosen anything yet should be shown something real, and a `null`
   * selection renders an empty sidebar that looks like a bug. */
  get selectedWorkspaceId(): string | null {
    return this.#selectedWorkspaceId
  }

  /** Move the selection.
   *
   * False for an unknown workspace rather than deselecting: `set_active_workspace`
   * naming an id this node does not have is a client bug, and silently clearing the
   * selection would hide it. */
  setActiveWorkspace(workspaceId: string): boolean {
    if (!this.#config.projects.some((project) => project.id === workspaceId)) return false
    this.#selectedWorkspaceId = workspaceId
    return true
  }

  /** The whole world, as one snapshot's worth.
   *
   * `listJobs` is async and a snapshot is not, so the jobs are resolved before the
   * publisher asks. That is the publisher's concern rather than this method's: it
   * is the thing that cannot be async, because it answers inside a socket callback.
   */
  async loadJobs(): Promise<IpcJobView[]> {
    const jobs = await this.#jobManager.listJobs()
    return jobs.map((job) => this.jobView(job))
  }

  snapshot(): {
    readonly tailscale: IpcTailscaleStatusView
    readonly outboxPendingCount: number
    readonly workspaces: IpcWorkspaceView[]
    readonly jobs: IpcJobView[]
    readonly panes: IpcPaneView[]
  } {
    return {
      // `unknown`, not `stopped`: this process does not probe Tailscale, and
      // reporting `stopped` tells an operator their tailnet is down when the truth
      // is that nobody asked. The schema has a value for precisely this.
      tailscale: { status: "unknown", address: null, peerCount: 0 },
      outboxPendingCount: this.#outboxPendingCount(),
      workspaces: this.#config.projects.map((project) => ({
        workspaceId: project.id,
        name: project.id,
        // The project's own configured root, redacted rather than rewritten. It IS
        // the allowlist entry, so it has already been checked by
        // `assertProjectAllowed`; an operator comparing the sidebar against their
        // config should see the same string.
        projectRoot: redactString(project.path, { customSecrets: this.#customSecrets }),
        projectId: this.projectIdFor(project.id),
        selected: project.id === this.#selectedWorkspaceId,
      })),
      // Jobs are filled in by `attachJobs`, because the store is async and a
      // snapshot cannot be. A snapshot taken before the first load reports no jobs,
      // which is honest: nothing has been read yet, and the next snapshot corrects
      // it rather than guessing.
      jobs: [],
      // Panes come from the PTY host, which this build does not embed. An empty
      // list is honest: the pane count reads zero, and a client attached to real
      // panes is attached to a different daemon.
      panes: [],
    }
  }

  /** The configured project id for a workspace, or the workspace id itself.
   *
   * A project's configured id is not required to satisfy the wire's id pattern --
   * `projectConfigSchema.id` is only `min(1)` -- so it is parsed rather than cast.
   * A configured id that cannot be published falls back to the workspace id, which
   * has the same problem, and then to a fixed literal. Failing the whole snapshot
   * over one project's id would take every attached client down for a cosmetic
   * reason, and the fallback still renders.
   */
  projectIdFor(workspaceId: string): IpcJobView["projectId"] {
    const parsed = projectIdSchema.safeParse(workspaceId)
    if (parsed.success) return parsed.data
    const fallback = projectIdSchema.safeParse("unknown")
    if (fallback.success) return fallback.data
    throw new Error("the wire's project id pattern rejects every value, including its own fallback")
  }

  /** One job in the shape the bus publishes. */
  jobView(job: JobRecord): IpcJobView {
    const projectDir = job.trigger.project_dir
    // The session id comes off OpenCode, not off this repository's own id scheme,
    // so it is parsed rather than cast: a snapshot that failed its own schema would
    // take the client's connection down, and the failure would be reported as a
    // client bug rather than as a daemon one.
    const sessionId = job.opencodeSessionId === undefined
      ? null
      : sessionIdSchema.safeParse(job.opencodeSessionId)
    return {
      jobId: job.id,
      // The trigger names a directory, not a project id, so the configured project
      // it falls under is resolved here. This is the same lookup
      // `assertProjectAllowed` performed when the job was admitted, which is why it
      // can trust its answer rather than re-deriving one.
      projectId: this.projectIdFor(this.workspaceFor(projectDir)),
      workspaceId: this.workspaceFor(projectDir),
      sessionId: sessionId !== null && sessionId.success ? sessionId.data : null,
      state: jobStateOf(job),
      blockedReason: blockedReasonOf(job),
      // The error string is environment- and agent-authored in the general case --
      // it is whatever OpenCode or a filesystem call said -- so it is redacted on
      // the way out rather than on the way in, where every producer would have to
      // remember to.
      detail:
        job.error === undefined
          ? null
          : redactString(job.error, { customSecrets: this.#customSecrets }),
      updatedAt: job.updatedAt,
    }
  }

  /** The configured project whose root contains `projectDir`.
   *
   * Component-wise containment, so `/srv/apps/application` does not answer for
   * `/srv/apps/app`. A directory matching nothing configured falls back to the
   * directory's own name, because a job for an unconfigured project can only have
   * got here through a path this node does not know -- and the sidebar showing that
   * name is more useful than showing nothing.
   */
  workspaceFor(projectDir: string): string {
    const normalized = projectDir.replace(/\/+$/, "")
    const exact = this.#config.projects.find(
      (project) => project.path.replace(/\/+$/, "") === normalized,
    )
    if (exact !== undefined) return exact.id
    const containing = this.#config.projects.find((project) => {
      const root = project.path.replace(/\/+$/, "")
      return normalized.startsWith(`${root}/`)
    })
    if (containing !== undefined) return containing.id
    const basename = normalized.split("/").pop()
    return basename !== undefined && basename.length > 0 ? basename : "unknown"
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.#jobManager.getJob(jobId)
    // Already finished: there is nothing to cancel, and reporting success would
    // suggest the cancel did something.
    if (job.status === "completed" || job.status === "failed") return false
    await this.#jobManager.markFailed(jobId, "cancelled by an operator")
    return true
  }
}

/**
 * Forwards the drainer's durable writes onto the bus.
 *
 * Attached after construction because the drainer needs its observer before it can
 * run and the publisher needs the drainer to exist. Events arriving before the
 * attach are dropped; see the module header.
 */
export class QueueBridge implements IngressLifecycleObserver {
  #publisher: IpcPublisher | undefined

  /** Start forwarding to a publisher. */
  attach(publisher: IpcPublisher): void {
    this.#publisher = publisher
  }

  /**
   * Reduce an `ingress_outbox` row to the four columns the bus publishes.
   *
   * A named reduction rather than an inline map, because the omission is the point:
   * `payload_json` is on the row and is NOT in this list, so no path from a queue
   * event to a client can reach an admitted request's body.
   */
  static entryOf(record: IngressRecord): {
    readonly job_id: string
    readonly status: "pending" | "sending"
    readonly attempts: number
    readonly created_at_ms: number
  } {
    return {
      job_id: record.job_id,
      status: record.status === "sending" ? "sending" : "pending",
      attempts: record.attempts,
      created_at_ms: record.created_at_ms,
    }
  }

  claimed(records: readonly IngressRecord[]): void {
    this.#publisher?.queueItemsAdded(records.map((record) => QueueBridge.entryOf(record)))
  }

  /** A row left the queue because dispatch succeeded. */
  acknowledged(jobId: string): void {
    this.#publisher?.queueItemRemoved(jobId)
  }

  /** A row left the queue permanently.
   *
   * The same wire event as an acknowledgement -- both mean "this row is gone" --
   * and a client that needs to tell them apart reads the job's state, which is
   * `done` with a detail explaining the failure. A second removal variant would mean
   * editing the contract for a distinction the snapshot already carries, and the
   * error code is deliberately not forwarded: it is daemon-internal text and the
   * contract's own comment forbids an error message carrying internals. */
  exhausted(jobId: string): void {
    this.#publisher?.queueItemRemoved(jobId)
  }
}

/** What {@link startIpcBus} was given. */
export interface IpcBusOptions {
  readonly config: BridgeConfig
  readonly jobManager: JobManager
  readonly bridge: QueueBridge
  readonly outboxPendingCount: () => number
  /** Absent in a build with no PTY host; pane commands are then refused. */
  readonly panes?: PaneController
  readonly customSecrets?: readonly string[]
  readonly socketPath?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/** A running bus, and the world view behind it. */
export interface IpcBusHandle {
  readonly publisher: IpcPublisher
  readonly world: EngineWorldSource
  stop(): Promise<void>
}

/**
 * Build and start the bus.
 *
 * The world source is adapted rather than passed directly because its jobs are read
 * asynchronously while a snapshot -- answered inside a socket callback -- is not.
 * The adapter keeps a cache and refills it when it is empty, so the first client to
 * attach pays one store read and every later snapshot is synchronous. Publishing an
 * empty job list is never wrong: the client detects the stale cache, asks again, and
 * the next snapshot is correct.
 */
export async function startIpcBus(options: IpcBusOptions): Promise<IpcBusHandle> {
  const world = new EngineWorldSource({
    config: options.config,
    jobManager: options.jobManager,
    outboxPendingCount: options.outboxPendingCount,
    customSecrets: options.customSecrets,
  })

  let cachedJobs: IpcJobView[] = []
  let reading = false

  const publisher = new IpcPublisher({
    // Parsed rather than cast: a node id that does not satisfy the contract would
    // otherwise reach every frame and fail on the FIRST client's socket, which
    // reads as a client bug rather than as a misconfigured daemon.
    nodeId: nodeIdSchema.parse(options.config.agent_id),
    world: {
      snapshot: () => ({ ...world.snapshot(), jobs: cachedJobs }),
      selectedWorkspaceId: world.selectedWorkspaceId,
      cancelJob: (jobId) => world.cancelJob(jobId),
    },
    panes: options.panes,
    customSecrets: options.customSecrets,
    socketPath: options.socketPath,
    environment: options.environment,
  })

  /**
   * Refresh the job cache.
   *
   * Guarded against overlap rather than awaited from the snapshot, because a socket
   * callback cannot await and a snapshot that blocked on the job store would stall
   * every other peer's frames behind one slow disk read.
   */
  const refreshJobs = (): void => {
    if (reading) return
    reading = true
    void world
      .loadJobs()
      .then((jobs) => {
        cachedJobs = jobs
      })
      .catch(() => {
        // A store that cannot be read leaves the previous snapshot in place, which
        // is the last thing that was true. Reporting a failure instead would mean a
        // snapshot that describes no jobs at all, indistinguishable from a node
        // that has never run one.
      })
      .finally(() => {
        reading = false
      })
  }
  refreshJobs()

  await publisher.start()
  options.bridge.attach(publisher)
  return {
    publisher,
    world,
    stop: () => publisher.stop(),
  }
}
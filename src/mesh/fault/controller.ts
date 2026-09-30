/**
 * M4.9 — the controller node.
 *
 * Everything on this node is a production class: `MeshNodeRegistry`,
 * `MeshControllerLease`, `DispatchCoordinator`, `ProjectionEngine`,
 * `MeshProjectionUpdater`, `MeshEventGateway`, `MeshEventIngestor`,
 * `OutboxDeliverer` and `MeshReconciler`, each over a real SQLite file. The only
 * things this module adds are named here, because a reader deserves to know what
 * is not production code:
 *
 *   - **`receive`.** A router that dispatches on `recordType` to the seam that owns
 *     it. M4.6's integration fixture writes the same router in its Fastify route
 *     bodies; a mesh gateway writes it in front of these seams. It decides nothing.
 *   - **The ingest store.** M4.6 wires `MeshEventIngestor` to whatever holds the
 *     controller's events. Here that is the kernel's own log, because a projection
 *     derived from an array a test happened to be holding would not survive the
 *     restart this harness exists to exercise.
 *   - **`restart`.** Close every handle, rebuild over the SAME paths. That is what
 *     a process restart is, and it is why `DurableNodeFiles` exists.
 */
import { createContractError } from "../../orchestration/errors.js"
import type { NodeId, ProjectId, RunId } from "../../orchestration/identifiers.js"
import { eventIdSchema } from "../../orchestration/identifiers.js"
import { DispatchCoordinator, type CoordinatorDependencies, type EffectBoundary } from "../../orchestration/coordinator/index.js"
import { SqliteEventStore } from "../../orchestration/event-store/event-store.js"
import type { StoredRunEvent } from "../../orchestration/event-store/types.js"
import { ProjectionEngine } from "../../orchestration/projections/projection-engine.js"
import type { RunProjectionState } from "../../orchestration/projections/types.js"
import { MeshNodeRegistry, SqliteNodeRegistryStore, type NodeRegistryStore } from "../registry/index.js"
import { MeshControllerLease, SqliteControllerLeaseStore, createUnreconciledNodeSource } from "../lease/index.js"
import type { ControllerLeaseStore, LeaseScope } from "../lease/types.js"
import { DurableEventOutbox, MeshEventIngestor, OutboxDeliverer, SqliteEventOutboxStore } from "../outbox/index.js"
import type { EventOutboxTransport, MeshOutboxEntry } from "../outbox/types.js"
import { MeshEventGateway, MeshProjectionUpdater, ProjectionSnapshotFallback } from "../gateway/events/index.js"
import type { GatewayResume, StreamedEvent } from "../gateway/events/types.js"
import { MeshReconciler } from "../gateway/reconcile/index.js"
import { meshAckSchema } from "../protocol/ack.js"
import type { MeshEvent } from "../protocol/event.js"
import { readRecordType } from "../protocol/registry.js"
import {
  closeDatabases,
  freshNodeFiles,
  openInboxDatabase,
  openKernelDatabase,
  openLeaseDatabase,
  openRegistryDatabase,
  removeNodeFiles,
  type DurableNodeFiles,
  type OpenDatabase,
  readPeerEvents,
  writePeerEvent,
} from "./durable.js"
import { aNodeIdentity, type NodeIdentity, type NodeTransportContext } from "./transport.js"
import { FAULT_MESH_ID, eventEnvelopeFor } from "./records.js"
import type { FaultClock, InboundHandler } from "./types.js"

export interface ControllerScope {
  readonly projectId: ProjectId
  readonly runId: RunId
}

export interface ControllerNode {
  readonly nodeId: NodeId
  readonly identity: NodeIdentity
  readonly scope: ControllerScope
  readonly files: DurableNodeFiles
  readonly boundary: EffectBoundary
  /** M4.3's registry. Enrollment writes its row here, so the harness reads it back. */
  readonly registry: MeshNodeRegistry
  /**
   * M4.3's store, for the ONE write that is not a read/ingest seam.
   *
   * `MeshNodeRegistry.enroll` is a static taking the store, and §4.2 makes an
   * accepted enrollment RESPONSE the only thing that makes a node addressable —
   * so the harness has to perform that write, and the store is the only way to.
   * Exposing it for exactly that, rather than wrapping `enroll` in a method, keeps
   * the registry's own "this is deliberately not a method" argument intact.
   */
  readonly registryStore: NodeRegistryStore
  /** M4.4's lease. A scenario applies a claim through the node's own seam. */
  readonly lease: MeshControllerLease
  /** Signed send through the proxy. The controller's only outbound path. */
  readonly send: NodeTransportContext["send"]
  /** The transport endpoint the proxy calls. */
  readonly receive: InboundHandler
  /** The lease history the worker's `RecordedLogReader` resolves against. */
  leaseHistory(scope: LeaseScope): ReturnType<ControllerLeaseStore["leaseHistory"]>
  /** The kernel seam, and hooks 1–4. */
  readonly coordinator: DispatchCoordinator
  /** A deliverer over the CURRENT store. Rebuilt per call so a restart cannot strand one. */
  deliverer(): OutboxDeliverer
  /** Enqueues a `mesh.event` this controller originated. */
  enqueue(event: MeshEvent, destination: NodeId): Promise<void>
  /** The current projection for the controller's run. */
  projection(): RunProjectionState | undefined
  /** Every peer event this controller ingested, in apply order. */
  ingested(): readonly MeshEvent[]
  /** `gateway.resume`, verbatim — including the refusal and the re-base. */
  resume(cursor: number | null): Promise<GatewayResume>
  /** Convenience over {@link resume} for the entries only. */
  stream(cursor: number | null): Promise<readonly StreamedEvent[]>
  /** Closes every handle and rebuilds over the same files. */
  restart(): Promise<void>
  close(): void
}

/**
 * Builds the controller.
 *
 * Everything mutable lives in `live` and every accessor reads it, so a captured
 * seam would be a handle to a CLOSED database after a restart — the confusing
 * failure `tests/unit/mesh/outbox/fixtures.ts` already designs around.
 */
export async function buildController(input: {
  readonly nodeId: NodeId
  readonly scope: ControllerScope
  readonly clock: FaultClock
  readonly boundary: EffectBoundary
  readonly transport: NodeTransportContext
  readonly files?: DurableNodeFiles
}): Promise<ControllerNode> {
  const { nodeId, scope, clock, boundary, transport } = input
  const files = input.files ?? freshNodeFiles(`controller-${String(nodeId)}`)
  const identity = aNodeIdentity(nodeId, clock, FAULT_MESH_ID)
  const leaseScope: LeaseScope = { projectId: scope.projectId, runId: scope.runId }

  interface Live {
    readonly databases: readonly OpenDatabase[]
    /** The kernel file, which also carries the harness's own peer-event table. */
    readonly kernelDatabase: OpenDatabase
    readonly kernel: SqliteEventStore
    readonly registry: MeshNodeRegistry
    readonly registryStore: NodeRegistryStore
    readonly lease: MeshControllerLease
    readonly leaseStore: ControllerLeaseStore
    readonly engine: ProjectionEngine
    readonly updater: MeshProjectionUpdater
    readonly gateway: MeshEventGateway
    readonly ingestor: MeshEventIngestor
    readonly reconciler: MeshReconciler
    readonly outbox: DurableEventOutbox
    readonly outboxStore: SqliteEventOutboxStore
    readonly coordinator: DispatchCoordinator
  }

  const build = (): Live => {
    const kernelDb = openKernelDatabase(files.kernelPath)
    const inboxDb = openInboxDatabase(files.inboxPath, clock.now)
    const leaseDb = openLeaseDatabase(files.leasePath, clock.now)
    const registryDb = openRegistryDatabase(files.registryPath, clock.now)
    const databases: readonly OpenDatabase[] = [kernelDb, inboxDb, leaseDb, registryDb]

    const kernel = new SqliteEventStore(kernelDb.driver)
    const registryStore = new SqliteNodeRegistryStore(registryDb.driver)
    const registry = new MeshNodeRegistry({ store: registryStore, now: clock.now })
    const unreconciled = createUnreconciledNodeSource()
    const leaseStore = new SqliteControllerLeaseStore(leaseDb.driver)
    const lease = new MeshControllerLease({ store: leaseStore, unreconciled: unreconciled.source, now: clock.now })
    const engine = new ProjectionEngine(kernel)
    const updater = new MeshProjectionUpdater({ engine, snapshots: kernel, boundary, now: clock.now })
    // The gateway rebuilds its stream window from the KERNEL LOG on construction.
    // The log is where peer events are already folded, and its `globalPosition`
    // continues across a restart, so a position handed to a client before the
    // restart still names the same event after it. Without this the gateway is a
    // cache that starts empty on every process start, and the first client to
    // resume is told `cursor_ahead` — the refusal reserved for "you are reading a
    // different stream" — while in fact it is reading this one.
    const gateway = new MeshEventGateway({
      now: clock.now,
      snapshots: new ProjectionSnapshotFallback(kernel),
      durableStream: { entries: () => durableStreamEntries(kernelDb, clock.now) },
    })
    const outboxStore = new SqliteEventOutboxStore(kernelDb.driver)
    const outbox = new DurableEventOutbox({ store: outboxStore, now: clock.now })

    // Peer events are written to the HARNESS's own durable table, not kept in an
    // array, and the table's `global_position` — not a counter held here — is what
    // the gateway's `position` is derived from. An array version accumulated
    // across a restart, so it reported pre-restart ingests as this process's own
    // and could not answer "was that redelivery after the restart still recognised
    // as a redelivery", which is the one question a restart makes interesting.
    const ingestor = new MeshEventIngestor({
      store: {
        seen: async (eventId) => ({
          ok: true,
          value: readPeerEvents(kernelDb).some((row) => row.event_id === eventId),
        }),
        apply: async (event: MeshEvent) => {
          writePeerEvent(kernelDb, {
            eventId: event.eventId,
            sourceNodeId: event.sourceNodeId,
            localSequence: event.localSequence,
            projectId: event.runProjectScope.projectId,
            runId: event.runProjectScope.runId,
            eventType: event.eventType,
            eventJson: JSON.stringify(event),
          })
          // The position the row was GIVEN is read back rather than predicted, so
          // the projection and the stream agree even if an insert was ignored as a
          // duplicate and the autoincrement moved on.
          const stored = readPeerEvents(kernelDb).find((row) => row.event_id === event.eventId)
          /* c8 ignore next -- the write above is what makes this row exist */
          if (stored === undefined) return { ok: true, value: undefined }
          updater.apply(peerEventAsStored(JSON.parse(stored.event_json) as MeshEvent, stored.global_position))
          return { ok: true, value: undefined }
        },
      },
    })

    const reconciler = new MeshReconciler({
      lease,
      unacknowledged: {
        commandIds: async () => ({ ok: true, value: [] }),
        eventIds: async () => ({ ok: true, value: [] }),
      },
      projections: {
        sessionForDispatch: async (scopeArg, dispatchId) => {
          const projection = engine.getProjection(scopeArg.runId)
          return { ok: true, value: projection?.dispatches[dispatchId]?.sessionId ?? null }
        },
      },
      snapshots: new ProjectionSnapshotFallback(kernel),
    })

    // Event ids are a per-node counter rather than a random source, so replaying a
    // scenario produces byte-identical events and a snapshot digest can be compared
    // ACROSS a restart directly.
    let eventSequence = kernel.readGlobal().length
    const dependencies: CoordinatorDependencies = {
      // The kernel log, WRAPPED. `CommandLog` is the kernel's own port for exactly
      // this — a caller that needs behaviour around an append without changing the
      // store — and what the wrapper adds is the one thing nothing else here does:
      // the projection is advanced from the COMMITTED bytes. Without it the engine
      // stays empty, and a coordinator whose `readRun` always answers `undefined`
      // evaluates `COMMAND_MATRIX` against nothing, which is the difference
      // between a matrix that refuses and a matrix that cannot.
      log: {
        append: (options) => {
          const appended = kernel.append(options)
          // A duplicate appends nothing, so there is nothing new to project. The
          // alternative — projecting the receipt's events again — would advance
          // nothing (the reducer declines a sequence at or below the watermark)
          // and would make `saved: false` indistinguishable from a real miss.
          if (!appended.duplicate) replayProjection()
          return appended
        },
      },
      now: () => new Date(clock.now()).toISOString(),
      newEventId: () => `evt-fault-${(eventSequence += 1)}`,
      boundary,
      readRun: (runId) => engine.getProjection(runId),
    }

    /**
     * Rebuilds the projection from the durable log, for this run.
     *
     * Read from the STORE rather than from the events just appended, so the
     * projection is derived from bytes that survived a commit — which is the
     * property the restart assertion needs and the one an in-memory list of
     * freshly-minted events could never have. `applyAll` declines any event at or
     * below the watermark, so calling this after every append is idempotent and
     * calling it on a freshly-built (empty) engine is a full replay.
     */
    const replayProjection = (): void => {
      updater.applyAll(kernel.readStream(scope.runId, { fromSequence: 1 }))
    }
    replayProjection()

    return {
      databases,
      kernelDatabase: kernelDb,
      kernel,
      registry,
      registryStore,
      lease,
      leaseStore,
      engine,
      updater,
      gateway,
      ingestor,
      reconciler,
      outbox,
      outboxStore,
      coordinator: new DispatchCoordinator(dependencies),
    }
  }

  let live = build()

  const controller: ControllerNode = {
    nodeId,
    identity,
    scope,
    files,
    boundary,
    send: transport.send,
    leaseHistory: (scopeArg) => live.leaseStore.leaseHistory(scopeArg),

    get registry() {
      return live.registry
    },

    get registryStore() {
      return live.registryStore
    },

    get lease() {
      return live.lease
    },

    get coordinator() {
      return live.coordinator
    },

    receive: (request) =>
      transport.withSignature(request.signature, async () => {
        const recordType = readRecordType(request.record)
        switch (recordType) {
          case "mesh.heartbeat":
            return { result: await live.registry.recordHeartbeat(request.record) }
          case "mesh.event": {
            const published = await live.gateway.publish(request.record)
            if (!published.ok) return { published }
            if (!published.outcome.accepted) {
              // The suppression outcome carries the event's ID and NOTHING ELSE,
              // and reading an `entry` off it would mean reaching past the
              // gateway into state it deliberately withheld: a duplicate is
              // answered from the id, because a redelivery converges onto the
              // entry already held and must not produce a second one. The ack's
              // `acknowledgedAt` is this node's clock for the same reason — it is
              // a receipt the CONTROLLER issues, so stamping it with the sender's
              // `observedAt` would report the peer's clock as its own.
              return { published, ack: eventAck(published.outcome.eventId, "duplicate", clock.now()) }
            }
            const payload = published.outcome.entry.payload as MeshEvent
            const result = await live.ingestor.ingest(payload)
            return { published, ingested: result, ack: eventAck(payload.eventId, "accepted", clock.now()) }
          }
          case "mesh.lease":
            return { result: await live.lease.applyLease(request.record) }
          case "mesh.reconciliation.request":
            return { result: await live.reconciler.reconcile(request.record) }
          default:
            return {
              refused: createContractError(
                "validation",
                "fault.route_unsupported",
                `The controller has no route for recordType '${String(recordType)}'. The harness router refuses rather than guessing a seam, because a route that interpreted a record no seam owns would be testing the router.`,
              ),
            }
        }
      }),

    deliverer() {
      const transportPort: EventOutboxTransport = {
        send: async (entry: MeshOutboxEntry) => {
          const response = await transport.send({
            from: nodeId,
            to: entry.destination,
            record: eventEnvelopeFor(entry, nodeId),
            method: "POST",
            path: "/v1/mesh/event",
          })
          return meshAckSchema.parse((response as { ack?: unknown }).ack)
        },
      }
      return new OutboxDeliverer({ store: live.outboxStore, transport: transportPort, now: clock.now, boundary })
    },

    async enqueue(event, destination) {
      const written = await live.outbox.enqueue({ event, destination })
      if (!written.ok) {
        throw new Error(`the controller refused to enqueue ${event.eventId}: ${written.error.code} — ${written.error.message}`)
      }
    },

    projection: () => live.engine.getProjection(scope.runId),
    // Derived from the DURABLE LOG, not from an array of events this process
    // happened to handle. The array version accumulated across a restart, so it
    // reported pre-restart ingests as this process's own and could not be used to
    // assert that a redelivery after a restart was still recognised as a
    // redelivery — which is the one question a restart makes interesting. Reading
    // the log makes the answer the same before and after a restart, because the
    // log is what the restart preserves.
    ingested: () =>
      readPeerEvents(live.kernelDatabase)
        .map((row) => JSON.parse(row.event_json) as MeshEvent),

    resume: (cursor) => live.gateway.resume(cursor, { scope: leaseScope as { projectId: ProjectId; runId: RunId } }),

    async stream(cursor) {
      const resumed = await live.gateway.resume(cursor, { scope: { projectId: scope.projectId, runId: scope.runId } })
      // Only the plain page is a stream. A re-base and a refusal are DIFFERENT
      // answers, and folding either into an entry list would make the one false
      // answer — "here is the newest thing I have" — expressible here.
      return resumed.kind === "resume" ? [...resumed.entries] : []
    },

    async restart() {
      closeDatabases(live.databases)
      live = build()
    },

    close() {
      closeDatabases(live.databases)
      removeNodeFiles(files)
    },
  }

  void leaseScope
  return controller
}

/**
 * The receipt the controller issues for a `mesh.event`.
 *
 * `acknowledgedAt` is the RECEIVER's clock, and the accepted branch deliberately
 * omits `acknowledgedThroughLocalSequence`: the position a cumulative ack retires
 * through is a claim about everything this node has applied, and the harness
 * redelivers individual events out of order by design, so publishing a watermark
 * here would let one delivery retire a record the node has not seen.
 */
function eventAck(eventId: string, outcome: "accepted" | "duplicate", acknowledgedAtMs: number) {
  return meshAckSchema.parse({
    acksEventId: eventIdSchema.parse(eventId),
    ackKind: "event",
    acknowledgedAt: new Date(acknowledgedAtMs).toISOString(),
    outcome,
  })
}

/**
 * The stream window a RESTARTED gateway rebuilds, read out of the durable table.
 *
 * `global_position` is the durable, restart-surviving identity of a row, and it
 * is what the gateway's `position` is derived from, so a position a client was
 * given before the restart still names the same event after it. Reading the
 * gateway's own `retained()` would defeat the purpose: that array dies with the
 * process being restored, which is the defect this function exists to fix.
 *
 * The table holds ONLY peer events, because those are the only ones that entered
 * the stream through `publish`. An event the controller originated never did, so
 * giving it a position here would leave a hole in the sequence a client resumes
 * against — and a position assigned to two different events is indistinguishable
 * at the client, which is the one place a stream's integrity is actually checked.
 */
function durableStreamEntries(kernelDb: OpenDatabase, now: () => number): StreamedEvent[] {
  return readPeerEvents(kernelDb).map((row) => {
    const event = JSON.parse(row.event_json) as MeshEvent
    return Object.freeze({
      // `global_position` is 1-based and gapless, which is exactly the gateway's
      // position contract.
      position: row.global_position,
      eventId: event.eventId,
      sourceNodeId: event.sourceNodeId,
      localSequence: event.localSequence,
      projectId: event.runProjectScope.projectId,
      runId: event.runProjectScope.runId,
      eventType: event.eventType,
      // The node's own INJECTED clock at restart time, never the event's
      // `observedAt`. Retention is a property of the retaining node, and a
      // restored window measured with the sender's clock would age out
      // immediately on a fast-clocked peer. Injected rather than `Date.now()`
      // because this harness has no ambient clock, and a determinism guard test
      // asserts exactly that.
      retainedFromMs: now(),
      payload: event,
    })
  })
}

/**
 * A peer event as the kernel log holds one.
 *
 * `sequence` is the mesh's per-SOURCE `localSequence`, which is a legitimate value
 * for the kernel's per-RUN sequence here because the harness runs one run with one
 * reporting node. A harness with two sources on one run would have to allocate run
 * sequences itself, and that allocation is a different question from this file's.
 */
function peerEventAsStored(event: MeshEvent, globalPosition: number): StoredRunEvent {
  return {
    globalPosition,
    eventId: event.eventId,
    projectId: event.runProjectScope.projectId,
    runId: event.runProjectScope.runId,
    sequence: event.localSequence,
    type: event.eventType as StoredRunEvent["type"],
    schemaVersion: 1,
    actor: event.event.actor,
    occurredAt: event.event.occurredAt,
    correlationId: event.event.correlationId,
    causation: event.event.causation ?? null,
    controllerEpoch: event.event.controllerEpoch,
    ...(event.event.commandId === undefined ? {} : { commandId: event.event.commandId }),
    payload: event.event.payload,
    event: event.event,
  }
}

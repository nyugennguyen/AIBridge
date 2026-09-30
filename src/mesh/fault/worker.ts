/**
 * M4.9 — the worker node.
 *
 * Real seams over real files: `MeshCommandInbox` on a durable
 * `SqliteCommandInboxStore`, `MeshCommandEpochGate` over a durable
 * `SqliteControllerLeaseStore`, `DurableEventOutbox` on a durable
 * `SqliteEventOutboxStore`, and `OutboxDeliverer` — which is where M4-B hooks 5
 * and 6 fire. The plan's restart requirement is "worker restart preserves
 * inbox/outbox and active-session references", and a restart that quietly dropped
 * any of the three would be a restart that agreed with the test rather than with
 * the protocol.
 *
 * ### The runtime seam
 *
 * {@link WorkerNode.applyCommand} is the ONE thing here that is not production
 * code, and it is named at every use. The mesh is what this harness exercises, not
 * an agent: the runtime stands in for "a dispatch was started and a session
 * exists", and its only interesting property is that it is IDEMPOTENT on
 * `commandId`, checked against the DURABLE inbox row rather than an in-memory set.
 * That check is what makes "no duplicate session" and "no duplicate prompt" real
 * across a redelivery and across a restart.
 */
import { createContractError } from "../../orchestration/errors.js"
import type { CommandId, NodeId, ProjectId, RunId, ApprovalId, DispatchId, LeaseId } from "../../orchestration/identifiers.js"
import { MeshCommandInbox, SqliteCommandInboxStore, type RecordedLogReader } from "../inbox/index.js"
import type { RecordedApproval, RecordedDispatch, RecordedLease } from "../inbox/authorization.js"
import type { RunProjectionState } from "../../orchestration/projections/types.js"
import { MeshCommandEpochGate, MeshControllerLease, SqliteControllerLeaseStore, createUnreconciledNodeSource } from "../lease/index.js"
import type { ControllerLeaseStore, RecordedCommandStateResolver } from "../lease/types.js"
import { DurableEventOutbox, OutboxDeliverer, SqliteEventOutboxStore } from "../outbox/index.js"
import type { EventOutboxTransport, MeshOutboxEntry } from "../outbox/types.js"
import { meshAckSchema } from "../protocol/ack.js"
import type { MeshEvent } from "../protocol/event.js"
import { readRecordType } from "../protocol/registry.js"
import type { EffectBoundary } from "../../orchestration/coordinator/types.js"
import {
  closeDatabases,
  freshNodeFiles,
  openInboxDatabase,
  openKernelDatabase,
  openLeaseDatabase,
  removeNodeFiles,
  type DurableNodeFiles,
  type OpenDatabase,
} from "./durable.js"
import { eventEnvelopeFor, FAULT_MESH_ID } from "./records.js"
import type { FaultClock, InboundHandler } from "./types.js"
import type { NodeIdentity, NodeTransportContext } from "./transport.js"

/** What the worker's runtime did. The "no duplicate work" assertion target. */
export interface RuntimeObservation {
  /** `commandId`s the runtime was asked to execute, in order, including retries. */
  readonly executions: readonly CommandId[]
  /** Sessions that exist. One per dispatch, however many times it was delivered. */
  readonly sessions: readonly string[]
  /** Prompts submitted, in order. A duplicate prompt is the defect. */
  readonly prompts: readonly { readonly sessionId: string; readonly prompt: string }[]
}

export interface WorkerScope {
  readonly projectId: ProjectId
  readonly runId: RunId
}

export interface WorkerNode {
  readonly nodeId: NodeId
  readonly controllerNodeId: NodeId
  readonly identity: NodeIdentity
  readonly scope: WorkerScope
  readonly files: DurableNodeFiles
  readonly boundary: EffectBoundary
  readonly send: NodeTransportContext["send"]
  readonly receive: InboundHandler
  /** M4.5's inbox. */
  readonly inbox: MeshCommandInbox
  readonly inboxRows: SqliteCommandInboxStore
  /** M4.4's lease, holding the CONTROLLER's lease as delivered. */
  readonly lease: MeshControllerLease
  /** M4.5's durable outbox and its pump, which is where hooks 5 and 6 fire. */
  readonly outbox: DurableEventOutbox
  readonly outboxRows: SqliteEventOutboxStore
  deliverer(): OutboxDeliverer
  /** The lease this worker holds, or `null`. */
  heldLease(): Promise<{ readonly epoch: number; readonly controllerNodeId: NodeId; readonly leaseId: LeaseId } | null>
  /** What the runtime did. */
  runtime(): RuntimeObservation
  /**
   * Applies an admitted command, and only if it has not been applied.
   *
   * Idempotent on `commandId`, checked against the durable inbox row: a row that
   * already carries a result is a command whose effect ran, so re-running it is
   * the duplicate session this harness exists to detect. Reading the row rather
   * than an in-memory set is what makes the check survive a restart.
   */
  applyCommand(commandId: CommandId, options?: { readonly prompt?: string }): Promise<{ readonly sessionId: string; readonly launched: boolean }>
  /** Enqueues a `mesh.event` this worker is reporting. */
  report(event: MeshEvent): Promise<void>
  /** Closes every handle and rebuilds over the same files. */
  restart(): Promise<void>
  close(): void
}

export async function buildWorker(input: {
  readonly nodeId: NodeId
  readonly controllerNodeId: NodeId
  readonly scope: WorkerScope
  readonly clock: FaultClock
  readonly boundary: EffectBoundary
  readonly transport: NodeTransportContext
  /**
   * The CONTROLLER's recorded log, which is what step 4 of the inbox resolves a
   * command's authorization pointers against.
   *
   * On a two-node mesh the grant lives on the controller, and a worker that
   * synthesized one would be testing the "authorize against your own payload"
   * defect this milestone closed twice. `controllerRecordedLog` is the reader the
   * integration fixture already builds, and for the same reason.
   */
  readonly recordedLog: RecordedLogReader
  /**
   * The recorded states the gate reads, supplied by the scenario from the
   * CONTROLLER's projections for the same reason.
   */
  readonly recordedState: RecordedCommandStateResolver
  readonly files?: DurableNodeFiles
}): Promise<WorkerNode> {
  const { nodeId, controllerNodeId, scope, clock, boundary, transport } = input
  const files = input.files ?? freshNodeFiles(`worker-${String(nodeId)}`)
  // The TRANSPORT's identity, never a second one built here. `aNodeIdentity`
  // constructs fresh trust, pin and replay stores, so building another one for the
  // inbox would authenticate every command against a store that has never heard
  // of the controller: one node, one identity, and the harness wires the peer in
  // through the same object the inbox verifies against.
  const identity = transport.identity
  const leaseScope = { projectId: scope.projectId, runId: scope.runId }

  // The runtime's observations live OUTSIDE the rebuilt seams on purpose: a restart
  // is a new process, and a fake runtime that forgot its sessions on restart would
  // make "no duplicate session" pass for the wrong reason — by having nothing to
  // duplicate. What survives is the durable inbox row, and the assertion compares
  // the two.
  const executions: CommandId[] = []
  const sessions: string[] = []
  const prompts: { sessionId: string; prompt: string }[] = []

  interface Live {
    readonly databases: readonly OpenDatabase[]
    readonly inbox: MeshCommandInbox
    readonly inboxRows: SqliteCommandInboxStore
    readonly lease: MeshControllerLease
    readonly leaseStore: ControllerLeaseStore
    readonly outbox: DurableEventOutbox
    readonly outboxRows: SqliteEventOutboxStore
  }

  const build = (): Live => {
    const kernelDb = openKernelDatabase(files.kernelPath)
    const inboxDb = openInboxDatabase(files.inboxPath, clock.now)
    const leaseDb = openLeaseDatabase(files.leasePath, clock.now)
    const databases: readonly OpenDatabase[] = [kernelDb, inboxDb, leaseDb]

    const inboxRows = new SqliteCommandInboxStore(inboxDb.driver)
    const leaseStore = new SqliteControllerLeaseStore(leaseDb.driver)
    const lease = new MeshControllerLease({
      store: leaseStore,
      unreconciled: createUnreconciledNodeSource().source,
      now: clock.now,
    })
    const gate = new MeshCommandEpochGate({
      lease,
      recipientNodeId: nodeId,
      now: clock.now,
      recordedState: input.recordedState,
    })
    const inbox = new MeshCommandInbox({
      store: inboxRows,
      now: clock.now,
      authenticate: {
        authenticate: async () => {
          const signature = transport.currentSignature()
          if (signature === undefined) {
            return {
              ok: false,
              error: createContractError(
                "validation",
                "inbox.signature_absent",
                "The submission arrived with no request signature in scope, so no node can be attributed to it. A submission that reached the inbox without one has bypassed the transport, and the inbox refuses it rather than guessing a sender.",
              ),
            }
          }
          const verified = await identity.provider.authenticate({
            expectedNodeId: controllerNodeId,
            expectedMeshId: FAULT_MESH_ID,
            signature,
          })
          return verified.ok ? { ok: true, value: { nodeId: verified.value.nodeId } } : verified
        },
      },
      gate,
      recordedLog: input.recordedLog,
      acks: { emit: async () => undefined },
    })
    const outboxRows = new SqliteEventOutboxStore(kernelDb.driver)
    return {
      databases,
      inbox,
      inboxRows,
      lease,
      leaseStore,
      outbox: new DurableEventOutbox({ store: outboxRows, now: clock.now }),
      outboxRows,
    }
  }

  let live = build()

  const worker: WorkerNode = {
    nodeId,
    controllerNodeId,
    identity,
    scope,
    files,
    boundary,
    send: transport.send,

    get inbox() {
      return live.inbox
    },
    get inboxRows() {
      return live.inboxRows
    },
    get lease() {
      return live.lease
    },
    get outbox() {
      return live.outbox
    },
    get outboxRows() {
      return live.outboxRows
    },

    receive: (request) =>
      transport.withSignature(request.signature, async () => {
        const recordType = readRecordType(request.record)
        switch (recordType) {
          case "mesh.lease":
            return { result: await live.lease.applyLease(request.record) }
          case "mesh.command":
            return { result: await live.inbox.submit(request.record) }
          default:
            return {
              refused: createContractError(
                "validation",
                "fault.route_unsupported",
                `The worker has no route for recordType '${String(recordType)}'. The harness router refuses rather than guessing a seam, because a route that interpreted a record no seam owns would be testing the router.`,
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
      return new OutboxDeliverer({ store: live.outboxRows, transport: transportPort, now: clock.now, boundary })
    },

    async heldLease() {
      const held = await live.lease.heldLease(leaseScope)
      if (!held.ok || held.value === null) return null
      return { epoch: held.value.epoch, controllerNodeId: held.value.controllerNodeId, leaseId: held.value.leaseId }
    },

    runtime: () => ({ executions: [...executions], sessions: [...sessions], prompts: [...prompts] }),

    async applyCommand(commandId, applyOptions) {
      const row = await live.inbox.lookup(commandId)
      if (!row.ok || row.value === null) {
        throw new Error(
          `applyCommand was asked to execute '${commandId}', which has no inbox row. The effect must not run for a command the inbox never admitted: that is the whole "persisted before acknowledged" ordering.`,
        )
      }
      if (row.value.resultJson !== null) {
        const stored = JSON.parse(row.value.resultJson) as { sessionId: string }
        return { sessionId: stored.sessionId, launched: false }
      }
      await live.inbox.markRuntimeAccepted(commandId)
      const sessionId = `sess-${commandId}`
      if (!sessions.includes(sessionId)) sessions.push(sessionId)
      executions.push(commandId)
      if (applyOptions?.prompt !== undefined) prompts.push({ sessionId, prompt: applyOptions.prompt })
      await live.inbox.recordResult(commandId, { sessionId })
      return { sessionId, launched: true }
    },

    async report(event) {
      const written = await live.outbox.enqueue({ event, destination: controllerNodeId })
      if (!written.ok) {
        throw new Error(`the worker refused to enqueue ${event.eventId}: ${written.error.code} — ${written.error.message}`)
      }
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

  return worker
}

/**
 * The CONTROLLER's recorded log, as the worker's `RecordedLogReader`.
 *
 * All three readers, not just the lease, and that is the difference between a
 * harness that can execute a dispatch and one that cannot. The inbox's step 4
 * turns the payload's `approvalId`/`dispatchId` pointers into facts by reading the
 * log, and a reader that answered `null` for both made every `dispatch.execute`
 * unrepresentable: the acceptance criterion "no duplicate session" has no session
 * to duplicate unless a launch can be admitted at all. So approvals and dispatches
 * are read from the CONTROLLER's projection, which is where that node's
 * `approval.decided` and `dispatch.proposed` events landed.
 *
 * Reading the controller's PROJECTION rather than a second copy of its events is
 * deliberate. The projection is what the controller itself would answer a state
 * question from, so a worker and its controller cannot disagree about whether a
 * dispatch was approved; two independent readers of the same log are two answers,
 * and the acceptance run is exactly the case where they must not diverge.
 */
export function controllerRecordedLog(input: {
  readonly leaseHistory: (scope: { readonly projectId: ProjectId; readonly runId: RunId }) => Promise<
    | {
        ok: true
        value: readonly {
          leaseId: LeaseId
          projectId: ProjectId
          runId: RunId
          controllerNodeId: NodeId
          epoch: number
          expiresAt: string
        }[]
      }
    | { ok: false; error: ReturnType<typeof createContractError> }
  >
  /** The controller's live projection, read at CALL time so a restart is followed. */
  readonly projection: () => RunProjectionState | undefined
  readonly scope: { readonly projectId: ProjectId; readonly runId: RunId }
}): RecordedLogReader {
  return {
    async approval(approvalId: ApprovalId): Promise<{ ok: true; value: RecordedApproval | null }> {
      const recorded = input.projection()?.approvals[approvalId]
      if (recorded === undefined) return { ok: true, value: null }
      const approval: RecordedApproval = {
        approvalId: recorded.approvalId,
        state: recorded.state,
        decision: recorded.decision,
        envelopeDigest: recorded.envelopeDigest,
        dispatchId: recorded.dispatchId,
      }
      return { ok: true, value: approval }
    },
    async dispatch(dispatchId: DispatchId): Promise<{ ok: true; value: RecordedDispatch | null }> {
      const recorded = input.projection()?.dispatches[dispatchId]
      if (recorded === undefined) return { ok: true, value: null }
      const dispatch: RecordedDispatch = {
        dispatchId: recorded.dispatchId,
        state: recorded.lifecycleState,
        envelopeDigest: recorded.envelopeDigest,
        projectId: recorded.projectId,
        runId: recorded.runId,
      }
      return { ok: true, value: dispatch }
    },
    async lease(leaseId: LeaseId) {
      const history = await input.leaseHistory(input.scope)
      if (!history.ok) return history
      const found = history.value.find((entry) => entry.leaseId === leaseId)
      if (found === undefined) return { ok: true, value: null }
      const lease: RecordedLease = {
        leaseId: found.leaseId,
        projectId: found.projectId,
        runId: found.runId,
        controllerNodeId: found.controllerNodeId,
        epoch: found.epoch,
        expiresAt: found.expiresAt,
      }
      return { ok: true, value: lease }
    },
  }
}

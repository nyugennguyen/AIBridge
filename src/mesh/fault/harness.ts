/**
 * M4.9 — the two-node fault harness.
 *
 * Two real nodes, one deterministic proxy between them, and one scripted fault
 * log. Everything a fault can do happens at the TRANSPORT: bytes are delayed,
 * dropped, duplicated, reordered, cut off, or delivered to a node that has just
 * died. No seam's state is ever touched by the harness, and the only thing the
 * proxy calls on a node is `receive(record, signature)`.
 *
 * ### What "restart" means here
 *
 * {@link FaultMesh.restartNode} closes a node's database handles and rebuilds it
 * over the SAME paths. That is a process restart, and it is why the durable
 * assertions mean anything: an in-memory store that survived would make
 * "inbox/outbox preserved" vacuous, and one that did not survive would be a cache.
 *
 * ### What "crash at boundary N" means here
 *
 * {@link FaultMesh.crashAt} arms the {@link CrashBoundary} to throw from one
 * `EffectBoundary` hook. The seam unwinds, the scenario catches the
 * {@link InjectedCrash}, the node is restarted, and the scenario continues. The
 * crash fires ONCE and disarms itself, because the harness models a process that
 * died once rather than a hook that is permanently fatal.
 */
import { nodeIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import { CURRENT_SCHEMA_VERSION } from "../../orchestration/versioning.js"
import type { EffectBoundary } from "../../orchestration/coordinator/types.js"
import type { AggregateStateContext } from "../../orchestration/invariants.js"
import type { OrchestrationCommand } from "../../orchestration/types.js"
import {
  LegacyTranslation,
  legacyTranslationContextSchema,
  type LegacyTriggerAcceptance,
} from "../../orchestration/legacy/translation.js"
import { NodeKeyPair, buildEnrollmentRequest, decideEnrollment, issueEnrollmentCode } from "../identity/index.js"
import { MeshNodeRegistry } from "../registry/index.js"
import type { RecordedCommandStateResolver } from "../lease/types.js"
import type { CommandInboxOutcome } from "../inbox/types.js"
import type { LeaseOperationOutcome } from "../lease/types.js"
import { CrashBoundary, InjectedCrash } from "./boundary.js"
import { MeshFaultProxy, proxyFaultError, type ProxyFault, type ProxySendInput } from "./proxy.js"
import { buildController, type ControllerNode, type ControllerScope } from "./controller.js"
import { buildWorker, controllerRecordedLog, type WorkerNode } from "./worker.js"
import { aNodeIdentity, aTransportContext, type NodeTransportContext } from "./transport.js"
import {
  FAULT_LEASE,
  FAULT_LEASE_DURATION_SECONDS,
  FAULT_MESH_ID,
  FAULT_PROJECT,
  FAULT_PROJECT_PATH,
  FAULT_RUN,
  leaseEnvelope,
} from "./records.js"
import {
  ScriptedClock,
  type EffectBoundaryHook,
  type FaultLink,
  type FaultScript,
  type TransmissionRecord,
} from "./types.js"

/** `T0`. Every other instant in a scenario is this plus a number. */
export const FAULT_T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

/**
 * The controller's node id.
 *
 * A constant rather than a parameter because the harness has exactly two nodes and
 * a second controller would be a THIRD node and a different harness — the
 * two-controller split brain is M4.4's `tests/unit/mesh/lease/split-brain.test.ts`
 * and a three-node mesh is not what this file is for.
 */
export const FAULT_CONTROLLER_NODE_ID: NodeId = nodeIdSchema.parse("node-fault-controller")

/** The sender a JOINING node uses before it has a node id of its own. */
const PENDING_NODE: NodeId = nodeIdSchema.parse("node-enr-pending")

/** The harness, and the three observables: the clock, the wire, and the boundary. */
export interface FaultMesh {
  readonly controller: ControllerNode
  readonly worker: WorkerNode
  readonly clock: ScriptedClock
  readonly proxy: MeshFaultProxy
  readonly boundary: CrashBoundary
  readonly scope: ControllerScope
  readonly controllerNodeId: NodeId
  readonly workerNodeId: NodeId
  /** Replaces the scripted fault log. Its match counters reset with it. */
  script(faults: FaultScript): void
  /** Severs a directed link, or every link when `link` is omitted. */
  partition(link?: FaultLink): void
  /** Restores a directed link, or every link when `link` is omitted. */
  heal(link?: FaultLink): void
  /** Arms `hook` to throw on its Nth firing. */
  crashAt(hook: EffectBoundaryHook, occurrence?: number): void
  /** Clears any armed crash, which is what a restarted process has. */
  clearCrash(): void
  /** Kills a node. Records addressed to it fail until it is restarted. */
  killNode(nodeId: NodeId): void
  /** Restarts a node over its own durable files. */
  restartNode(nodeId: NodeId): Promise<void>
  /** The fault timeline, in the order the proxy was asked to move records. */
  timeline(): readonly TransmissionRecord[]
  /**
   * M4-B hook 8: a legacy trigger translated against the CONTROLLER's coordinator.
   *
   * Present on the harness because hook 8 is the one boundary the WIRE cannot
   * reach. Hooks 1–4 are the coordinator, 5–6 the outbox pump, 7 the projection
   * updater, and all of those sit behind a record a scenario can send. Translation
   * is entered by a local HTTP route on a legacy JSON store, there is no
   * `mesh.*` family for it, and a fault harness without this method could not
   * crash at boundary 8 at all — which is how a declared-and-typed hook survives
   * a milestone as decoration.
   */
  translateLegacyTrigger(job: unknown, options?: { readonly epoch?: number }): LegacyTriggerAcceptance
  close(): void
}

export interface BuildFaultMeshOptions {
  readonly projectId?: ControllerScope["projectId"]
  readonly runId?: ControllerScope["runId"]
  /** The shared start instant. Every other instant is `T0` plus a number. */
  readonly startMs?: number
  readonly script?: FaultScript
  /**
   * The recorded states the worker's gate reads.
   *
   * Takes the harness rather than a resolver so a scenario can read the
   * CONTROLLER's projection at call time, which is the whole point: the worker's
   * gate must decide against what the controller actually recorded, and a
   * resolver captured before the controller recorded anything would answer from a
   * stale projection.
   */
  readonly recordedState?: (mesh: FaultMesh) => RecordedCommandStateResolver
}

/**
 * Builds the two-node harness, with the worker ENROLLED.
 *
 * Enrollment is real and happens here rather than being asserted afterwards: a
 * joining node has a key and a provisional name, and the controller mints the node
 * id from the enrollment code hash. A harness that picked the worker's id up front
 * would be asserting on a fact the protocol derives, and every id in a transcript
 * would be one the fixture chose.
 */
export async function buildFaultMesh(options: BuildFaultMeshOptions = {}): Promise<FaultMesh> {
  const startMs = options.startMs ?? FAULT_T0_MS
  const clock = new ScriptedClock(startMs)
  const proxy = new MeshFaultProxy(clock, options.script ?? [])
  const boundary = new CrashBoundary()
  const scope: ControllerScope = { projectId: options.projectId ?? FAULT_PROJECT, runId: options.runId ?? FAULT_RUN }

  const controllerTransport = aTransportContext({
    identity: aNodeIdentity(FAULT_CONTROLLER_NODE_ID, clock, FAULT_MESH_ID),
    clock,
    submit: (sendInput: ProxySendInput) => proxy.send(sendInput),
  })
  const controller = await buildController({
    nodeId: FAULT_CONTROLLER_NODE_ID,
    scope,
    clock,
    boundary,
    transport: controllerTransport,
  })

  // The enrollment code's ENTROPY is fixed, so the code, its hash and therefore the
  // DERIVED node id are the same on every run. A harness that used the default
  // random source would produce a different worker id per run, which is fine for
  // uniqueness and useless for a transcript a reviewer reads against a test.
  const issued = await issueEnrollmentCode(
    { meshId: FAULT_MESH_ID, issuedBy: "operator", now: clock.now(), entropy: () => "aibridge-fault-harness-enrollment-code" },
    controllerTransport.identity.codes,
  )
  if (!issued.ok) {
    controller.close()
    throw new Error(`the fault harness could not issue an enrollment code: ${issued.error.code} — ${issued.error.message}`)
  }

  const joiningKey = NodeKeyPair.generate()
  const request = buildEnrollmentRequest({
    meshId: FAULT_MESH_ID,
    enrollmentId: issued.value.enrollmentId,
    codeHash: issued.value.codeHash,
    keyPair: joiningKey,
    nodeDisplayName: "fault-worker",
    provisionalNodeId: "fault-worker-pending",
    requestedAt: new Date(clock.now()).toISOString(),
    codeExpiresAt: new Date(clock.now() + 600_000).toISOString(),
    senderNodeId: PENDING_NODE,
  })
  const decision = await decideEnrollment(
    { request, now: clock.now() },
    { codes: controllerTransport.identity.codes, pins: controllerTransport.identity.pins, trust: controllerTransport.identity.trust },
  )
  if (decision.outcome !== "accepted") {
    controller.close()
    throw new Error(`the fault harness could not enroll its worker: ${String(decision.rejectionReason)}`)
  }
  await controllerTransport.identity.admitPeer({ nodeId: decision.nodeId, keyPair: joiningKey }, clock.now())
  // Trust and a pin make the worker ATTRIBUTABLE; the registry row makes it
  // ADDRESSABLE, and §4.2 makes the accepted enrollment response the only thing
  // that writes it. `admitPeer` above deliberately touches only the identity
  // stores — collapsing the two would produce a node that can authenticate and
  // cannot be found by anything that reads the mesh, which is precisely the gap
  // this line closes.
  const registered = await MeshNodeRegistry.enroll(controller.registryStore, {
    meshId: FAULT_MESH_ID,
    nodeId: decision.nodeId,
    nodeKeyId: joiningKey.keyId,
    displayName: "fault-worker",
    enrolledAt: clock.now(),
  })
  if (!registered.ok) {
    controller.close()
    throw new Error(
      `the fault harness could not make its worker addressable: ${registered.error.code} — ${registered.error.message}`,
    )
  }
  const enrolled = await controller.registry.node(decision.nodeId)
  if (!enrolled.ok || enrolled.value === null) {
    controller.close()
    throw new Error("the enrollment was accepted but produced no registry row, so the worker is not addressable")
  }

  const workerTransport = aTransportContext({
    identity: aNodeIdentity(decision.nodeId, clock, FAULT_MESH_ID),
    clock,
    submit: (sendInput: ProxySendInput) => proxy.send(sendInput),
  })
  // The worker trusts and pins the CONTROLLER, because the controller is the node
  // whose commands it authenticates. A node's trust store is for its peers, not for
  // itself, and getting that backwards would make every command unattributable.
  await workerTransport.identity.admitPeer(
    { nodeId: FAULT_CONTROLLER_NODE_ID, keyPair: controllerTransport.identity.keyPair },
    clock.now(),
  )

  // Declared before the worker is built and filled in after, because the resolver
  // reads the controller and the mesh object needs the worker. The indirection is the
  // harness's own wiring and is the reason the resolver sees the CURRENT projection
  // rather than the one that existed when the worker was constructed.
  let meshRef: FaultMesh | null = null
  const recordedState =
    options.recordedState?.({
      get controller() {
        return controller
      },
      get worker() {
        /* c8 ignore next -- only reachable if a scenario reads it before the mesh exists */
        if (meshRef === null) throw new Error("the harness's recorded-state resolver was read before the mesh was built")
        return meshRef.worker
      },
      clock,
      proxy,
      boundary,
      scope,
      controllerNodeId: FAULT_CONTROLLER_NODE_ID,
      workerNodeId: decision.nodeId,
      script: () => undefined,
      partition: () => undefined,
      heal: () => undefined,
      crashAt: () => undefined,
      clearCrash: () => undefined,
      killNode: () => undefined,
      restartNode: async () => undefined,
      timeline: () => [],
      // The mesh does not exist yet, and a resolver is built BEFORE the worker so
      // it can already read the controller. Throwing rather than returning a
      // plausible empty answer is the honest stub: a silent no-op here would let
      // a scenario that reached for it during construction believe it had
      // translated something.
      translateLegacyTrigger: () => {
        throw new Error("the harness's recorded-state resolver was built before the mesh and cannot translate a legacy trigger")
      },
      close: () => undefined,
    }) ?? projectionRecordedState(() => controller.projection())

  const worker = await buildWorker({
    nodeId: decision.nodeId,
    controllerNodeId: FAULT_CONTROLLER_NODE_ID,
    scope,
    clock,
    boundary,
    transport: workerTransport,
    recordedLog: controllerRecordedLog({
      leaseHistory: (leaseScope) => controller.leaseHistory(leaseScope),
      // Read through a thunk, not captured: the worker outlives controller
      // restarts, and a reader holding the pre-restart projection would answer a
      // post-restart command from state the controller no longer holds.
      projection: () => controller.projection(),
      scope,
    }),
    recordedState,
  })

  proxy.register(FAULT_CONTROLLER_NODE_ID, controller.receive)
  proxy.register(worker.nodeId, worker.receive)

  const mesh: FaultMesh = {
    controller,
    worker,
    clock,
    proxy,
    boundary,
    scope,
    controllerNodeId: FAULT_CONTROLLER_NODE_ID,
    workerNodeId: worker.nodeId,
    script: (faults) => proxy.arm(faults),
    partition: (link) => proxy.partition(link),
    heal: (link) => proxy.heal(link),
    crashAt: (hook, occurrence) => boundary.arm(hook, occurrence),
    clearCrash: () => boundary.disarm(),
    killNode: (nodeId) => proxy.takeDown(nodeId),
    async restartNode(nodeId) {
      proxy.bringUp(nodeId)
      // A restarted process has no crash pending. Leaving the arming in place would
      // make "restart and continue" untestable and would model a permanently fatal
      // hook rather than a process that died once.
      boundary.disarm()
      if (nodeId === FAULT_CONTROLLER_NODE_ID) {
        await controller.restart()
        return
      }
      if (nodeId === worker.nodeId) {
        await worker.restart()
        return
      }
      throw new Error(`restartNode was asked for '${String(nodeId)}', which is not a node of this harness`)
    },
    timeline: () => proxy.timeline(),
    translateLegacyTrigger: (job, translateOptions) => {
      // Rebuilt per call so a CONTROLLER RESTART is followed. A translation
      // holding the pre-restart coordinator would append into a closed database,
      // and the crash-at-8 scenario is exactly the one that restarts the node.
      const translation = new LegacyTranslation({
        mode: "present",
        context: legacyTranslationContextSchema.parse({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          sourceProfileId: "profile-fault-harness",
          controllerNodeId: FAULT_CONTROLLER_NODE_ID,
          controllerEpoch: translateOptions?.epoch ?? 1,
          leaseId: String(FAULT_LEASE),
          pathResolutionBase: "/srv/apps",
          localAgentId: "fault-controller",
          agentMappings: [
            {
              legacyAgentId: "dev-main",
              nodeId: FAULT_CONTROLLER_NODE_ID,
              installationId: "installation-opencode-fault-controller",
              runtimeKind: "opencode",
            },
            {
              legacyAgentId: "test-vps",
              nodeId: FAULT_CONTROLLER_NODE_ID,
              installationId: "installation-opencode-fault-controller",
              runtimeKind: "opencode",
            },
          ],
          projectMappings: [
            {
              legacyProjectId: "app",
              projectId: FAULT_PROJECT,
              projectPathId: String(FAULT_PROJECT_PATH),
              targetNodeId: FAULT_CONTROLLER_NODE_ID,
              configuredPath: "/srv/apps/app",
            },
          ],
        }),
        now: () => new Date(clock.now()).toISOString(),
        commands: { submit: (command) => controller.coordinator.submit(command) },
        boundary,
      })
      return translation.acceptTrigger(job)
    },
    close: () => {
      worker.close()
      controller.close()
    },
  }
  meshRef = mesh
  return mesh
}

/**
 * The controller's projection, as the recorded state a worker's gate reads.
 *
 * `lifecycleState` and never the derived `state`, because a projection reports a
 * run as `paused` and a dispatch as `queued`, and `COMMAND_MATRIX` speaks the
 * kernel's lifecycle vocabulary. This is the same distinction
 * `MeshCommandEpochGate` documents for the context it builds.
 *
 * The aggregates are selected by the ids the COMMAND names, not by taking the
 * first of each. The earlier version read `Object.values(...)[0]`, which is the
 * same answer as the controller's own gate only while a run has exactly one
 * dispatch — and the moment it has two, the worker would judge a second
 * `dispatch.execute` against the first one's recorded state and license a launch
 * the matrix forbids. The selection below mirrors `DispatchCoordinator`'s own
 * `#matrixContext` arm for arm, so the two readers cannot drift.
 */
export function projectionRecordedState(read: () => ReturnType<ControllerNode["projection"]>): RecordedCommandStateResolver {
  return {
    async resolve(command) {
      const projection = read()
      if (projection === undefined) return { ok: true, value: {} }
      const named = namedAggregatesOf(command)
      const value: AggregateStateContext = { runState: projection.run.lifecycleState }
      const task = named.taskId === undefined ? undefined : projection.tasks[named.taskId]
      if (task !== undefined) value.taskState = task.lifecycleState
      const dispatch = named.dispatchId === undefined ? undefined : projection.dispatches[named.dispatchId]
      if (dispatch !== undefined) value.dispatchState = dispatch.lifecycleState
      const approval = named.approvalId === undefined ? undefined : projection.approvals[named.approvalId]
      if (approval !== undefined) value.approvalState = approval.state
      const session =
        named.sessionId === undefined
          ? undefined
          : projection.sessions[named.sessionId] ??
            // `dispatch.timeout.request` names no session, but the matrix row
            // constrains the session the dispatch owns, so the lookup is by
            // dispatch — the same derivation `DispatchCoordinator.#matrixContext`
            // makes, and for the same reason: two derivations of "which session
            // does this command act on" would be two answers.
            (command.type === "dispatch.timeout.request"
              ? Object.values(projection.sessions).find((candidate) => candidate.dispatchId === command.payload.dispatchId)
              : undefined)
      if (session !== undefined) value.sessionState = session.state
      return { ok: true, value }
    },
  }
}

/**
 * Which recorded aggregate each arm of `COMMAND_MATRIX` reads, per command type.
 *
 * A `switch` over every command type rather than a structural probe, for the reason
 * `../inbox/authorization.ts` uses for its digest switch: a command type added
 * without a row here would silently read the WRONG aggregate, and a matrix arm
 * evaluated against a neighbouring dispatch's state is exactly the class of
 * authorization bug the plan's "recorded log, never your own payload" rule exists
 * to prevent. Exhaustive by construction, so the compiler refuses the omission.
 *
 * `dispatch.retry` answers with the PREVIOUS attempt, because that is the
 * dispatch the matrix row constrains and the one the recorded log has to hold.
 */
function namedAggregatesOf(command: OrchestrationCommand): {
  readonly taskId?: string
  readonly dispatchId?: string
  readonly approvalId?: string
  readonly sessionId?: string
} {
  switch (command.type) {
    case "run.create":
    case "run.pause":
    case "run.resume":
    case "run.cancel":
      return {}
    case "dispatch.propose":
      return { taskId: command.payload.dispatch.envelope.taskId, dispatchId: command.payload.dispatch.envelope.dispatchId }
    case "dispatch.approve":
      return {
        taskId: command.payload.dispatch.envelope.taskId,
        dispatchId: command.payload.dispatch.envelope.dispatchId,
        approvalId: command.payload.approval.approvalId,
      }
    case "dispatch.retry":
      return { taskId: command.payload.dispatch.envelope.taskId, dispatchId: command.payload.previousDispatchId }
    case "dispatch.execute":
      return {
        taskId: command.payload.dispatch.envelope.taskId,
        dispatchId: command.payload.dispatch.envelope.dispatchId,
        approvalId: command.payload.approval.approvalId,
      }
    case "dispatch.timeout.request":
      return { dispatchId: command.payload.dispatchId }
    case "session.prompt":
    case "session.respond":
    case "session.interrupt":
    case "session.terminate":
      return { sessionId: command.payload.sessionId }
  }
}

export interface DeliverALeaseOptions {
  readonly issuedAtMs?: number
  readonly epoch?: number
  readonly durationSeconds?: number
  readonly leaseId?: string
  readonly operation?: "claim" | "renew" | "release" | "takeover"
  readonly predecessorLeaseId?: string
  readonly predecessorEpoch?: number
  readonly takeoverReason?: string
  readonly acknowledgedUnreconciledNodeIds?: readonly NodeId[]
}

/**
 * A lease the controller claims and the worker is TOLD about.
 *
 * The controller applies it through its own seam and the worker through its own,
 * because a worker does not claim a lease: it is told which controller drives the
 * run, and its gate compares every command's epoch against that record. A worker
 * that claimed its own would be a second authority, which is the split brain M4.4
 * exists to prevent.
 */
export async function deliverALease(
  mesh: FaultMesh,
  options: DeliverALeaseOptions = {},
): Promise<{ readonly controller: LeaseOperationOutcome; readonly worker: unknown }> {
  const issuedAtMs = options.issuedAtMs ?? mesh.clock.now()
  const durationSeconds = options.durationSeconds ?? FAULT_LEASE_DURATION_SECONDS
  const envelope = leaseEnvelope({
    leaseId: options.leaseId ?? (options.epoch === 2 ? successorLeaseId() : String(FAULT_LEASE)),
    controllerNodeId: mesh.controllerNodeId,
    recipientNodeId: mesh.workerNodeId,
    epoch: options.epoch ?? 1,
    operation: options.operation ?? "claim",
    issuedAtMs,
    expiresAtMs: issuedAtMs + durationSeconds * 1000,
    ...(options.predecessorLeaseId === undefined ? {} : { predecessorLeaseId: options.predecessorLeaseId }),
    ...(options.predecessorEpoch === undefined ? {} : { predecessorEpoch: options.predecessorEpoch }),
    ...(options.takeoverReason === undefined ? {} : { takeoverReason: options.takeoverReason }),
    ...(options.acknowledgedUnreconciledNodeIds === undefined
      ? {}
      : { acknowledgedUnreconciledNodeIds: options.acknowledgedUnreconciledNodeIds }),
  })
  const controller = await mesh.controller.lease.applyLease(envelope)
  const worker = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: envelope })
  return { controller, worker }
}

function successorLeaseId(): string {
  return String(FAULT_LEASE).replace(/-e1$/, "-e2")
}

/** The inbox outcome inside a worker's response, or `null` when there is not one. */
export function inboxOutcomeOf(response: unknown): CommandInboxOutcome | null {
  if (typeof response !== "object" || response === null) return null
  const result = (response as { result?: unknown }).result
  if (typeof result !== "object" || result === null) return null
  if (!("outcome" in result)) return null
  return result as CommandInboxOutcome
}

/** The lease outcome inside a response, or `null` when there is not one. */
export function leaseOutcomeOf(response: unknown): LeaseOperationOutcome | null {
  if (typeof response !== "object" || response === null) return null
  const result = (response as { result?: unknown }).result
  if (typeof result !== "object" || result === null) return null
  if (!("outcome" in result)) return null
  return result as LeaseOperationOutcome
}

export { CrashBoundary, InjectedCrash, MeshFaultProxy, proxyFaultError }
export type { ControllerNode, ControllerScope, WorkerNode, EffectBoundary, ProxyFault }

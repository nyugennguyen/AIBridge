/**
 * M4.9 — the shared scenario every fault test starts from.
 *
 * A two-node `buildFaultMesh` with the lease delivered and a run whose dispatch
 * is proposed AND approved, which is the smallest state a `dispatch.execute` can
 * be admitted against: the worker's inbox authorizes the command against the
 * controller's RECORDED log, so a dispatch that was only proposed is refused at
 * step 4 with `inbox.approval_not_recorded`, and a test that stopped at
 * `dispatch.propose` would be asserting on a refusal it did not mean to reach.
 *
 * Every instant here is `T0` plus a number, and every id goes through the kernel's
 * branded schema. Nothing reads a wall clock, because a fault test whose outcome
 * depends on how fast the machine is has stopped being a fault test.
 */
import { FAULT_T0_MS, buildFaultMesh, type BuildFaultMeshOptions, type FaultMesh } from "../../../../src/mesh/fault/harness.js"
import {
  FAULT_PROJECT,
  FAULT_RUN,
  aDispatchEnvelope,
  aMeshEvent,
  anApproval,
  anApprovedDispatch,
  aProposedDispatch,
  commandEnvelope,
  eventEnvelope,
  leaseEnvelope,
  type CommandEnvelopeInput,
} from "../../../../src/mesh/fault/records.js"
import type { MeshEvent } from "../../../../src/mesh/protocol/event.js"
import { commandIdSchema, correlationIdSchema, epochSchema, leaseIdSchema, type CommandId, type LeaseId } from "../../../../src/orchestration/identifiers.js"
import { actorSchema, orchestrationCommandSchema, runSchema, taskSchema } from "../../../../src/orchestration/schemas.js"
import type { Approval, Dispatch, OrchestrationCommand, Run, Task } from "../../../../src/orchestration/types.js"

/** The lease every epoch-1 command in this file is minted under. */
export const FAULT_LEASE_ID: LeaseId = leaseIdSchema.parse("lease-run-fault-1-e1")

/** The lease a takeover produces, and therefore the id epoch-2 commands name. */
export const SUCCESSOR_LEASE_ID: LeaseId = leaseIdSchema.parse("lease-run-fault-1-e2")

/** The command id `commandEnvelope` mints for a `dispatch.execute`. */
export const EXECUTE_COMMAND_ID: CommandId = commandIdSchema.parse("cmd-fault-dispatch-execute")

/** `T0` plus an offset, for every envelope stamp in the suite. */
export function at(offsetMs: number): number {
  return FAULT_T0_MS + offsetMs
}

export function aRun(): Run {
  return runSchema.parse({
    schemaVersion: 1,
    runId: FAULT_RUN,
    projectId: FAULT_PROJECT,
    goal: "prove the mesh converges under fault",
    state: "draft",
    paused: false,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    externalReferences: [],
  })
}

export function aTask(): Task {
  return taskSchema.parse({
    schemaVersion: 1,
    taskId: "task-fault-1",
    runId: FAULT_RUN,
    projectId: FAULT_PROJECT,
    title: "run under fault",
    description: "the M4.9 acceptance dispatch",
    state: "ready",
    failurePolicy: "block",
    dependencies: [],
    externalReferences: [],
  })
}

export interface FaultScenario {
  readonly mesh: FaultMesh
  /** Any controller command, minted against the lease for `epoch`. */
  command(overrides: Record<string, unknown>): OrchestrationCommand
  /** A `run.create` naming {@link aRun} and {@link aTask}, at `epoch`. */
  runCreateFor(epoch: number): OrchestrationCommand
  /** A dispatch envelope for `targetNodeId` at `epoch`. */
  dispatchEnvelope(epoch: number, dispatchId?: string): Dispatch["envelope"]
  /** A `dispatch.propose` for the envelope at `epoch`. */
  proposeCommand(epoch: number): OrchestrationCommand
  /** A `dispatch.approve` for the envelope at `epoch`. */
  approveCommand(epoch: number): OrchestrationCommand
  /** A wire `mesh.command` for `dispatch.execute` at `epoch`. */
  executeRecord(epoch: number, overrides?: Partial<CommandEnvelopeInput>): Record<string, unknown>
  /** A `mesh.event` this worker would report, addressed at the controller. */
  reportFor(index: number, sessionId?: string): MeshEvent
  /** The `mesh.event` ENVELOPE for {@link reportFor}. */
  reportEnvelopeFor(index: number, sessionId?: string): Record<string, unknown>
}

/**
 * The mesh plus a command factory, and nothing that has been submitted yet.
 *
 * The scenario is a FACTORY rather than a performed run because every fault test
 * needs to choose its own order, and a fixture that had already driven
 * `run.create` would make a test whose subject is a crash at `beforeValidate`
 * start from a state that hook could never be observed in.
 */
export async function aFaultScenario(options: BuildFaultMeshOptions = {}): Promise<FaultScenario> {
  const mesh = await buildFaultMesh(options)
  const run = aRun()
  const task = aTask()

  const controllerCommand = (over: Record<string, unknown>): OrchestrationCommand =>
    orchestrationCommandSchema.parse({
      schemaVersion: 1,
      commandId: "cmd-fault-controller",
      projectId: FAULT_PROJECT,
      runId: FAULT_RUN,
      actor: actorSchema.parse({ kind: "node", nodeId: mesh.controllerNodeId }),
      controllerNodeId: mesh.controllerNodeId,
      controllerEpoch: 1,
      leaseId: FAULT_LEASE_ID,
      issuedAt: "2026-09-28T00:00:01.000Z",
      expiresAt: "2026-09-28T00:00:29.000Z",
      correlationId: correlationIdSchema.parse("cmd-fault-controller"),
      causation: null,
      ...over,
    })

  const leaseIdFor = (epoch: number): LeaseId => leaseIdSchema.parse(epoch === 1 ? String(FAULT_LEASE_ID) : String(SUCCESSOR_LEASE_ID))

  /** `T0` plus `seconds`, as an RFC 3339 stamp. No wall clock is read to make one. */
  const stampAt = (seconds: number): string => new Date(FAULT_T0_MS + seconds * 1_000).toISOString()

  const scenario: FaultScenario = {
    mesh,
    command: controllerCommand,
    runCreateFor: (epoch) =>
      controllerCommand({
        commandId: "cmd-fault-run-create",
        controllerEpoch: epochSchema.parse(epoch),
        leaseId: leaseIdFor(epoch),
        issuedAt: stampAt(1),
        expiresAt: stampAt(29),
        type: "run.create",
        payload: { run, tasks: [task] },
      }),
    dispatchEnvelope: (epoch, dispatchId) => aDispatchEnvelope({ targetNodeId: mesh.workerNodeId, controllerEpoch: epoch, ...(dispatchId === undefined ? {} : { dispatchId }) }),
    proposeCommand: (epoch) =>
      controllerCommand({
        commandId: "cmd-fault-dispatch-propose",
        controllerEpoch: epochSchema.parse(epoch),
        leaseId: leaseIdFor(epoch),
        issuedAt: stampAt(2),
        expiresAt: stampAt(29),
        type: "dispatch.propose",
        payload: { dispatch: aProposedDispatch(scenario.dispatchEnvelope(epoch)) },
      }),
    approveCommand: (epoch) =>
      controllerCommand({
        commandId: "cmd-fault-dispatch-approve",
        controllerEpoch: epochSchema.parse(epoch),
        leaseId: leaseIdFor(epoch),
        issuedAt: stampAt(3),
        expiresAt: stampAt(29),
        type: "dispatch.approve",
        payload: {
          dispatch: anApprovedDispatch(scenario.dispatchEnvelope(epoch)),
          approval: anApproval(scenario.dispatchEnvelope(epoch)),
        },
      }),
    executeRecord: (epoch, overrides) => {
      const envelope = scenario.dispatchEnvelope(epoch)
      const dispatch: Dispatch = anApprovedDispatch(envelope)
      const approval: Approval = anApproval(envelope)
      return commandEnvelope({
        type: "dispatch.execute",
        payload: { dispatch, approval },
        controllerNodeId: mesh.controllerNodeId,
        targetNodeId: mesh.workerNodeId,
        leaseId: String(leaseIdFor(epoch)),
        epoch,
        issuedAtMs: at(4_000),
        expiresAtMs: at(29_000),
        ...overrides,
      })
    },
    reportFor: (index, sessionId) =>
      aMeshEvent({
        eventId: `evt-fault-report-${index}`,
        sourceNodeId: mesh.workerNodeId,
        localSequence: index,
        occurredAtMs: at(6_000 + index * 1_000),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    reportEnvelopeFor: (index, sessionId) => eventEnvelope(scenario.reportFor(index, sessionId), mesh.controllerNodeId),
  }
  return scenario
}

/** The `run.create` for `epoch` 1, for the tests that never leave it. */
export function runCreateOf(scenario: FaultScenario): OrchestrationCommand {
  return scenario.runCreateFor(1)
}

/**
 * The scenario with its lease, run, proposal and approval all in place.
 *
 * Everything here goes through the controller's OWN coordinator and the proxy, so
 * a test that starts from this function is starting from state the protocol
 * produced rather than from state a fixture asserted into existence.
 */
export async function anApprovedScenario(options: BuildFaultMeshOptions = {}): Promise<FaultScenario> {
  const scenario = await aFaultScenario(options)
  await deliverALease(scenario.mesh)
  const created = scenario.mesh.controller.coordinator.submit(runCreateOf(scenario))
  if (!created.ok) throw new Error(`the fault scenario could not create its run: ${created.error.code} — ${created.error.message}`)
  const proposed = scenario.mesh.controller.coordinator.submit(scenario.proposeCommand(1))
  if (!proposed.ok) throw new Error(`the fault scenario could not propose its dispatch: ${proposed.error.code} — ${proposed.error.message}`)
  const approved = scenario.mesh.controller.coordinator.submit(scenario.approveCommand(1))
  if (!approved.ok) throw new Error(`the fault scenario could not approve its dispatch: ${approved.error.code} — ${approved.error.message}`)
  return scenario
}

/** Sends one `mesh.lease` claim to the worker. Named so a lease reads as a lease. */
export async function deliverALease(mesh: FaultMesh, options: { readonly issuedAtMs?: number } = {}): Promise<{ readonly controller: unknown; readonly worker: unknown }> {
  const issuedAtMs = options.issuedAtMs ?? mesh.clock.now()
  const envelope = leaseEnvelope({
    leaseId: String(FAULT_LEASE_ID),
    controllerNodeId: mesh.controllerNodeId,
    recipientNodeId: mesh.workerNodeId,
    epoch: 1,
    operation: "claim",
    issuedAtMs,
    expiresAtMs: issuedAtMs + 30_000,
  })
  const controller = await mesh.controller.lease.applyLease(envelope)
  const worker = await mesh.controller.send({ from: mesh.controllerNodeId, to: mesh.workerNodeId, record: envelope })
  return { controller, worker }
}

/** The number of `mesh.command` rows the worker has admitted. */
export async function inboxRowCount(mesh: FaultMesh): Promise<number> {
  const listed = await mesh.worker.inboxRows.listInbox({})
  if (!listed.ok) throw new Error(`the worker's inbox could not be read: ${listed.error.code} — ${listed.error.message}`)
  return listed.value.length
}

/** The number of outbox rows the worker holds, whatever their status. */
export function outboxRowCount(mesh: FaultMesh): number {
  return mesh.worker.outboxRows.count({})
}

/** The status of every outbox row the worker holds, as `{outboxId: status}`. */
export function outboxStatuses(mesh: FaultMesh): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const record of mesh.worker.outboxRows.list({})) out[record.outboxId] = record.status
  return out
}

/** The fault code on a `ContractError` the proxy threw. */
export function faultCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

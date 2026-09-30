/**
 * M4.4 lease test fixtures.
 *
 * Every `mesh.lease` and every `mesh.command` is built as a PLAIN OBJECT and left
 * for `safeParseMeshEnvelope` to validate, on the same principle the registry
 * fixtures use: a fixture that parsed first would let a negative test pass for the
 * wrong reason, because the record would already be valid by the time the seam
 * refused it. The `overrides` are spread LAST so a test can inject a member the
 * schema must reject.
 *
 * Nothing here reads a clock. Every timestamp is `T0` plus a number, and the clock
 * is a closure the test moves by hand, because the whole subject of this directory
 * is what happens after `expiresAt` — and a fixture that called `Date.now()` would
 * turn that into a sleep, which is a test that passes on a slow machine and fails
 * on a fast one.
 */
import {
  CURRENT_SCHEMA_VERSION,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  type NodeId,
  type RunId,
} from "../../../../src/orchestration/identifiers.js"
import type { AggregateStateContext } from "../../../../src/orchestration/invariants.js"
import { actorSchema, approvalSchema, dispatchEnvelopeSchema, dispatchSchema, orchestrationCommandSchema, sessionSchema } from "../../../../src/orchestration/schemas.js"
import { createContractError } from "../../../../src/orchestration/errors.js"
import { digestDispatchEnvelope } from "../../../../src/orchestration/digest.js"
import { makeEnvelope } from "../../orchestration/fixtures/recorded-events.js"
import type { OrchestrationCommand, Session } from "../../../../src/orchestration/types.js"
import { openInMemoryDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import { meshLeaseSchema, type MeshLease } from "../../../../src/mesh/protocol/lease.js"
import { mintMeshCommand } from "../../../../src/mesh/protocol/command.js"
import { MeshControllerLease, createUnreconciledNodeSource } from "../../../../src/mesh/lease/lease.js"
import { InMemoryControllerLeaseStore } from "../../../../src/mesh/lease/memory-lease-store.js"
import { SqliteControllerLeaseStore } from "../../../../src/mesh/lease/sqlite-lease-store.js"
import { runMeshLeaseMigrations } from "../../../../src/mesh/lease/migrations.js"
import { MeshCommandEpochGate, requiredRecordedStateEntities } from "../../../../src/mesh/lease/command-gate.js"
import type {
  ControllerLeaseStore,
  LeaseOperationOutcome,
  RecordedCommandStateResolver,
} from "../../../../src/mesh/lease/types.js"
import type { LeaseRecord, LeaseScope } from "../../../../src/mesh/lease/schemas.js"

export const PROJECT_ID = projectIdSchema.parse("project-release")
export const OTHER_PROJECT_ID = projectIdSchema.parse("project-other")
export const RUN_ID = runIdSchema.parse("run-release-1")
export const OTHER_RUN_ID = runIdSchema.parse("run-release-2")
export const CONTROLLER_A = nodeIdSchema.parse("node-controller-a")
export const CONTROLLER_B = nodeIdSchema.parse("node-controller-b")
export const WORKER_1 = nodeIdSchema.parse("node-worker-1")
export const WORKER_2 = nodeIdSchema.parse("node-worker-2")
export const WORKER_3 = nodeIdSchema.parse("node-worker-3")
export const LEASE_1 = leaseIdSchema.parse("lease-run-1-e1")
export const LEASE_2 = leaseIdSchema.parse("lease-run-1-e2")
export const LEASE_3 = leaseIdSchema.parse("lease-run-1-e3")
export const EPOCH_1 = 1
export const EPOCH_2 = 2
export const EPOCH_3 = 3
export const DURATION_SECONDS = 30

export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0_MS + seconds * 1000
}

/**
 * Milliseconds after `T0`.
 *
 * A separate name from {@link at} because the two are easy to confuse and the
 * confusion is SILENT: `at(30_000)` is thirty thousand seconds, not thirty
 * seconds, so a boundary test written with it passes against a lease that lapsed
 * eight hours ago and proves nothing about the bound.
 */
export function ms(milliseconds: number): number {
  return T0_MS + milliseconds
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function scopeFor(runId: RunId = RUN_ID): LeaseScope {
  return { projectId: PROJECT_ID, runId }
}

/**
 * A clock the test moves by hand.
 *
 * Exposes the function AND the setter rather than a forward-only `tick()`, because
 * the scenarios include a node whose clock is behind the lease's issue time and a
 * controller whose clock has stepped backwards, and neither is expressible as a
 * monotone tick.
 */
export class TestClock {
  #ms: number

  constructor(startMs: number = T0_MS) {
    this.#ms = startMs
  }

  now = (): number => this.#ms

  set(ms: number): void {
    this.#ms = ms
  }

  advance(ms: number): void {
    this.#ms += ms
  }
}

// --- Lease records -------------------------------------------------------

export interface LeaseOverrides extends Record<string, unknown> {
  readonly leaseId?: string
  readonly projectId?: string
  readonly runId?: string
  readonly controllerNodeId?: string
  readonly epoch?: number
  readonly operation?: string
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly durationSeconds?: number
}

/**
 * A `mesh.lease` envelope, built raw and left for the seam's parse.
 *
 * `expiresAt` defaults to `issuedAt + durationSeconds` and `durationSeconds` is
 * derived from the two, because `meshLeaseSchema` refuses a record where they
 * disagree. Computing one from the other in the fixture is what makes that
 * refusal a property the fixture can never accidentally trip for the wrong reason.
 */
export function leaseEnvelope(overrides: LeaseOverrides = {}): Record<string, unknown> {
  const issuedAt = (overrides.issuedAt as string | undefined) ?? iso(at(0))
  const durationSeconds = (overrides.durationSeconds as number | undefined) ?? DURATION_SECONDS
  const expiresAt = (overrides.expiresAt as string | undefined) ?? iso(at(0) + durationSeconds * 1000)
  const controllerNodeId = (overrides.controllerNodeId as string | undefined) ?? CONTROLLER_A
  const { leaseId, projectId, runId, epoch, operation, predecessorLeaseId, predecessorEpoch, takeoverReason, acknowledgedUnreconciledNodeIds, ...rest } = overrides

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.lease",
    messageId: `msg-lease-${leaseId ?? "1"}`,
    correlationId: `corr-lease-${leaseId ?? "1"}`,
    causation: null,
    senderNodeId: controllerNodeId,
    recipientNodeId: null,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(at(0)),
    expiresAt: iso(at(3600)),
    payload: {
      leaseId: leaseId ?? LEASE_1,
      projectId: projectId ?? PROJECT_ID,
      runId: runId ?? RUN_ID,
      controllerNodeId,
      epoch: epoch ?? EPOCH_1,
      operation: operation ?? "claim",
      issuedAt,
      expiresAt,
      durationSeconds,
      ...(predecessorLeaseId === undefined ? {} : { predecessorLeaseId }),
      ...(predecessorEpoch === undefined ? {} : { predecessorEpoch }),
      ...(takeoverReason === undefined ? {} : { takeoverReason }),
      acknowledgedUnreconciledNodeIds: acknowledgedUnreconciledNodeIds ?? [],
      ...rest,
    },
  }
}

/** A `mesh.lease` already schema-valid, for tests that want the typed payload. */
export function aLease(overrides: LeaseOverrides = {}): MeshLease {
  return meshLeaseSchema.parse(leaseEnvelope(overrides).payload)
}

export function claimEnvelope(overrides: LeaseOverrides = {}): Record<string, unknown> {
  return leaseEnvelope({ operation: "claim", ...overrides })
}

export function renewEnvelope(overrides: LeaseOverrides = {}): Record<string, unknown> {
  return leaseEnvelope({ operation: "renew", ...overrides })
}

export function releaseEnvelope(overrides: LeaseOverrides = {}): Record<string, unknown> {
  return leaseEnvelope({ operation: "release", ...overrides })
}

export interface TakeoverOverrides extends LeaseOverrides {
  readonly predecessorLeaseId?: string
  readonly predecessorEpoch?: number
  readonly takeoverReason?: string
  readonly acknowledgedUnreconciledNodeIds?: string[]
}

/**
 * A takeover, with the three precondition fields defaulted to something VALID.
 *
 * They are defaulted rather than left to the caller because a takeover missing any
 * of them is refused by the wire schema before the guard under test is ever
 * reached, and a test asserting `unreconciled_nodes_not_acknowledged` would fail
 * for a reason that has nothing to do with the acknowledgement.
 */
export function takeoverEnvelope(overrides: TakeoverOverrides = {}): Record<string, unknown> {
  return leaseEnvelope({
    operation: "takeover",
    predecessorLeaseId: LEASE_1,
    predecessorEpoch: EPOCH_1,
    takeoverReason: "controller A partitioned; operator moved control after inspecting the degraded nodes",
    ...overrides,
  })
}

// --- Commands ------------------------------------------------------------

const CONTROLLER_A_ACTOR = actorSchema.parse({ kind: "node", nodeId: CONTROLLER_A })

export interface CommandOverrides {
  readonly commandId?: string
  readonly type?: OrchestrationCommand["type"]
  readonly controllerEpoch?: number
  readonly controllerNodeId?: string
  readonly leaseId?: string
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly targetNodeId?: string
  readonly projectId?: string
  readonly runId?: string
  readonly payload?: Record<string, unknown>
  /** Overrides the `MeshCommand` after minting, to build a record the wire would refuse. */
  readonly tamper?: (record: Record<string, unknown>) => Record<string, unknown>
}

/**
 * A `mesh.command` envelope.
 *
 * Built by `mintMeshCommand` so the payload digest is real, which matters: a
 * command whose digest does not match is refused at the integrity step, and a
 * stale-epoch test that tripped that first would be asserting the wrong guard.
 * `tamper` exists for the one test that deliberately breaks the digest.
 */
export function commandEnvelope(overrides: CommandOverrides = {}): Record<string, unknown> {
  const controllerNodeId = overrides.controllerNodeId ?? CONTROLLER_A
  const commandId = overrides.commandId ?? "cmd-lease-1"
  const issuedAt = overrides.issuedAt ?? iso(at(1))
  const command = orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId,
    projectId: overrides.projectId ?? PROJECT_ID,
    runId: overrides.runId ?? RUN_ID,
    actor: CONTROLLER_A_ACTOR,
    controllerNodeId,
    controllerEpoch: overrides.controllerEpoch ?? EPOCH_1,
    leaseId: overrides.leaseId ?? LEASE_1,
    issuedAt,
    expiresAt: overrides.expiresAt ?? iso(at(20)),
    correlationId: commandId,
    causation: null,
    type: overrides.type ?? "run.pause",
    payload: overrides.payload ?? { reason: "operator asked" },
  })
  // Branded through the kernel's own schema rather than cast, for the reason every
  // id in this codebase is: a cast would put the type back without putting back the
  // check that the value is addressable, and a fixture that can pass an unbranded
  // string is a fixture whose negative tests can be satisfied by an id no node
  // could have.
  const targetNodeId = nodeIdSchema.parse(overrides.targetNodeId ?? WORKER_1)
  const minted = mintMeshCommand({ command, targetNodeId }) as unknown as Record<string, unknown>
  const payload = overrides.tamper ? overrides.tamper(minted) : minted

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.command",
    messageId: `msg-cmd-${commandId}`,
    correlationId: commandId,
    causation: null,
    senderNodeId: controllerNodeId,
    recipientNodeId: overrides.targetNodeId ?? WORKER_1,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(at(0)),
    expiresAt: iso(at(3600)),
    payload,
  }
}

/**
 * A `dispatch.retry` payload.
 *
 * Present because `dispatch.retry` is the command the expiry guard most has to
 * cover: it is AUTOMATIC, it creates new work, and it is what a controller's
 * scheduler reaches for the moment a partition heals. A test of the guard that
 * only used `run.pause` would leave the dangerous one unproven.
 *
 * Built on the shared orchestration envelope fixture rather than restated, for
 * the reason every fixture in this directory is built on something: a
 * hand-written dispatch envelope here would be a second vocabulary for a shape
 * the kernel owns, and the epoch cross-check in `orchestrationCommandSchema` would
 * then be a check against a fixture rather than against the contract.
 */
export function retryPayload(overrides: { readonly controllerEpoch?: number } = {}): Record<string, unknown> {
  const envelope = dispatchEnvelopeSchema.parse({
    ...makeEnvelope({ dispatchId: "dispatch-2", taskId: "task-1", attempt: 2, prompt: "Try again" }),
    controllerEpoch: overrides.controllerEpoch ?? EPOCH_1,
  })
  return {
    dispatch: dispatchSchema.parse({
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: "approved",
      createdAt: iso(at(0)),
      externalReferences: [],
    }),
    previousDispatchId: "dispatch-1",
    previousAttempt: 1,
  }
}

/**
 * A `dispatch` plus its `approval`, which together are the payload of both
 * `dispatch.approve` and `dispatch.execute`.
 *
 * Built here so the matrix tests can use a command type that constrains FOUR
 * aggregates — run, task, dispatch and approval — which is the widest row in
 * `COMMAND_MATRIX` and therefore the one that makes the gate's completeness rule
 * observable. A command type constraining only `run` would hide a dropped arm.
 */
export function dispatchWithApprovalPayload(): Record<string, unknown> {
  const envelope = dispatchEnvelopeSchema.parse({
    ...makeEnvelope({ dispatchId: "dispatch-1", taskId: "task-1", attempt: 1, prompt: "Do the work" }),
    controllerEpoch: EPOCH_1,
  })
  const digest = digestDispatchEnvelope(envelope)
  return {
    dispatch: dispatchSchema.parse({
      schemaVersion: 1,
      envelope,
      envelopeDigest: digest,
      state: "approved",
      createdAt: iso(at(0)),
      externalReferences: [],
    }),
    approval: approvalSchema.parse({
      schemaVersion: 1,
      approvalId: "approval-1",
      projectId: PROJECT_ID,
      runId: RUN_ID,
      dispatchId: envelope.dispatchId,
      envelopeDigest: digest,
      decision: "approved",
      state: "approved",
      basis: { kind: "user" },
      actor: { kind: "user", userId: "user-1" },
      decidedAt: iso(at(0)),
    }),
  }
}

/**
 * A `dispatch.propose` payload — the command type that CREATES new work.
 *
 * Used by the split-brain model as its "created work" event, because it is the
 * cheapest command type that unambiguously brings new work into existence: a
 * `run.pause` mutates policy without creating anything, and a `dispatch.execute`
 * would drag the recorded-approval precondition into a test about authority
 * ordering. The matrix constrains `run` and `task` for this type, and both are
 * supplied.
 */
export function proposePayload(controllerEpoch: number = EPOCH_1): Record<string, unknown> {
  const envelope = dispatchEnvelopeSchema.parse({
    ...makeEnvelope({ dispatchId: `dispatch-${controllerEpoch}`, taskId: "task-1", attempt: 1, prompt: "Do the work" }),
    controllerEpoch,
  })
  return {
    dispatch: dispatchSchema.parse({
      schemaVersion: 1,
      envelope,
      envelopeDigest: digestDispatchEnvelope(envelope),
      state: "proposed",
      createdAt: iso(at(0)),
      externalReferences: [],
    }),
  }
}

// --- Sessions ------------------------------------------------------------

export function aSession(overrides: Record<string, unknown> = {}): Session {
  return sessionSchema.parse({
    schemaVersion: 1,
    sessionId: "session-1",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: "task-1",
    dispatchId: "dispatch-1",
    nodeId: WORKER_1,
    installationId: "install-1",
    runtimeKind: "opencode",
    lifecycleState: "running",
    observedState: "working",
    ...overrides,
  })
}

/**
 * The live sessions of one worker, as the thing a partition must not change.
 *
 * A plain array plus a canonical serialisation, because the plan's guardrail is
 * about the CONTENT of that set being untouched, and comparing objects by identity
 * would pass even after a lifecycle state had been rewritten in place.
 */
export class SessionInventory {
  #sessions: Session[]

  constructor(sessions: readonly Session[] = []) {
    this.#sessions = [...sessions]
  }

  get sessions(): readonly Session[] {
    return this.#sessions
  }

  add(session: Session): void {
    this.#sessions = [...this.#sessions, session]
  }

  /**
   * The inventory as bytes.
   *
   * `JSON.stringify` over the sessions, which is deterministic here only because
   * the fixtures build the objects in a fixed key order — and that is the point: a
   * partition that rewrote a `lifecycleState` changes these bytes, and a partition
   * that changed nothing cannot.
   */
  canonical(): string {
    return JSON.stringify(this.#sessions)
  }
}

// --- The seams under test ------------------------------------------------

export interface LeaseHarness {
  readonly lease: MeshControllerLease
  readonly store: ControllerLeaseStore
  readonly clock: TestClock
  readonly unreconciled: ReturnType<typeof createUnreconciledNodeSource>
  close(): void
}

export function memoryLeaseHarness(clock: TestClock = new TestClock()): LeaseHarness {
  const store = new InMemoryControllerLeaseStore()
  const unreconciled = createUnreconciledNodeSource()
  return {
    lease: new MeshControllerLease({ store, unreconciled: unreconciled.source, now: clock.now }),
    store,
    clock,
    unreconciled,
    close: () => undefined,
  }
}

export function durableLeaseHarness(clock: TestClock = new TestClock()): LeaseHarness & { readonly driver: SqliteDriver } {
  const driver = openInMemoryDriver()
  runMeshLeaseMigrations(driver, { now: clock.now })
  const store = new SqliteControllerLeaseStore(driver)
  const unreconciled = createUnreconciledNodeSource()
  return {
    lease: new MeshControllerLease({ store, unreconciled: unreconciled.source, now: clock.now }),
    store,
    clock,
    unreconciled,
    driver,
    close: () => driver.close(),
  }
}

/** Both implementations of the port, so a semantic drift between them is a failure. */
export function bothLeaseHarnesses(): { label: string; make: (clock: TestClock) => LeaseHarness }[] {
  return [
    { label: "InMemoryControllerLeaseStore", make: (clock) => memoryLeaseHarness(clock) },
    { label: "SqliteControllerLeaseStore", make: (clock) => durableLeaseHarness(clock) },
  ]
}

/**
 * A recorded-state resolver that returns exactly what it is given.
 *
 * A FUNCTION rather than a canned object, because the point of most matrix tests
 * is to change ONE arm and see which guard fires. The gate's completeness rule is
 * the thing under test here, so a resolver that always answers everything would
 * make that rule unobservable.
 */
export function aRecordedStateResolver(
  states: AggregateStateContext | (() => AggregateStateContext),
): RecordedCommandStateResolver {
  return {
    async resolve() {
      const value = typeof states === "function" ? states() : states
      return { ok: true as const, value }
    },
  }
}

/** A resolver that always fails, standing in for an unreadable projection. */
export function aFailingRecordedStateResolver(code = "projection.unavailable"): RecordedCommandStateResolver {
  return {
    async resolve() {
      return {
        ok: false as const,
        error: createContractError("internal_failure", code, "The recorded projection could not be read."),
      }
    },
  }
}

export interface GateHarness {
  readonly gate: MeshCommandEpochGate
  /** The lease seam the gate reads. Seeded through here, not through the gate. */
  readonly lease: MeshControllerLease
  readonly leaseHarness: LeaseHarness
  close(): void
}

export function gateHarness(
  options: {
    readonly clock?: TestClock
    readonly recordedState?: RecordedCommandStateResolver
    readonly recipientNodeId?: NodeId
    readonly durable?: boolean
    /**
     * An existing lease seam to gate.
     *
     * Used by the split-brain model, where one worker node's lease is the thing
     * under test and the gate is merely how commands are offered to it. A gate
     * that took a STORE instead would let a test write authority without passing
     * the guards, which is a configuration production cannot build.
     */
    readonly lease?: MeshControllerLease
  } = {},
): GateHarness {
  const clock = options.clock ?? new TestClock(at(2))
  const leaseHarness = options.durable === true ? durableLeaseHarness(clock) : memoryLeaseHarness(clock)
  const lease = options.lease ?? leaseHarness.lease
  const gate = new MeshCommandEpochGate({
    lease,
    recordedState: options.recordedState ?? aRecordedStateResolver({ runState: "active" }),
    recipientNodeId: options.recipientNodeId ?? WORKER_1,
    now: clock.now,
  })
  return { gate, lease, leaseHarness, close: () => leaseHarness.close() }
}

/** Claims a run at `EPOCH_1` so a test can start from "somebody is driving this". */
export async function claimAt(
  harness: LeaseHarness,
  overrides: LeaseOverrides = {},
): Promise<LeaseOperationOutcome> {
  return harness.lease.claim(claimEnvelope(overrides))
}

/** The stored lease, or `null`. Throws rather than returning a `Result` a test would ignore. */
export async function storedLease(harness: LeaseHarness, scope: LeaseScope = scopeFor()): Promise<LeaseRecord | null> {
  const found = await harness.store.activeLease(scope)
  if (!found.ok) throw new Error(`fixture lease read failed: ${found.error.code} — ${found.error.message}`)
  return found.value
}

export { requiredRecordedStateEntities }

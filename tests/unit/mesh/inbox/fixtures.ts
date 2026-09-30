/**
 * M4.5 inbox test fixtures.
 *
 * Two rules this file follows, both learned the hard way elsewhere in this
 * codebase:
 *
 *   1. **Nothing reads a clock.** Every instant is `T0` plus a number, and the
 *      clock is a closure the test moves by hand. The subject of this directory
 *      is what happens across a crash boundary and a redelivery, and a fixture
 *      that called `Date.now()` would turn both into a sleep — a test that passes
 *      on a slow machine and fails on a fast one.
 *   2. **Records are built RAW and left for the seam's parse.** A fixture that
 *      schema-parsed first would let a negative test pass for the wrong reason:
 *      the record would already be valid by the time the inbox refused it. The
 *      one exception is `mintMeshCommand`, which is used so the payload digest is
 *      REAL — a command whose digest does not match is refused at the integrity
 *      step inside the gate, and a dedupe test that tripped that first would be
 *      asserting the wrong guard.
 *
 * The lease fixtures are IMPORTED from the M4.4 directory rather than restated,
 * so the two directories cannot disagree about what a lease is.
 */
import {
  CURRENT_SCHEMA_VERSION,
  approvalIdSchema,
  commandIdSchema,
  digestSchema,
  dispatchIdSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  type CommandId,
  type NodeId,
} from "../../../../src/orchestration/identifiers.js"
import {
  orchestrationCommandSchema,
  approvalSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  actorSchema,
} from "../../../../src/orchestration/schemas.js"
import { digestDispatchEnvelope } from "../../../../src/orchestration/digest.js"
import { makeEnvelope } from "../../orchestration/fixtures/recorded-events.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import { mintMeshCommand, verifyIncomingCommand } from "../../../../src/mesh/protocol/command.js"
import { safeParseMeshEnvelope } from "../../../../src/mesh/protocol/registry.js"
import type { MeshAck } from "../../../../src/mesh/protocol/ack.js"
import { runMigrations } from "../../../../src/orchestration/event-store/migrations.js"
import { openInMemoryDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import { MeshCommandInbox } from "../../../../src/mesh/inbox/inbox.js"
import { InMemoryCommandInboxStore } from "../../../../src/mesh/inbox/memory-inbox-store.js"
import { SqliteCommandInboxStore } from "../../../../src/mesh/inbox/sqlite-inbox-store.js"
import { runMeshInboxMigrations } from "../../../../src/mesh/inbox/migrations.js"
import type {
  CommandInboxStore,
  CommandInboxOutcome,
  GateOutcomeLike,
  InboxRow,
} from "../../../../src/mesh/inbox/types.js"
import type {
  RecordedApproval,
  RecordedDispatch,
  RecordedLease,
  RecordedLogReader,
} from "../../../../src/mesh/inbox/authorization.js"
import {
  CONTROLLER_A,
  EPOCH_1,
  LEASE_1,
  PROJECT_ID,
  RUN_ID,
  WORKER_1,
  T0_MS,
  at,
  iso,
} from "../lease/fixtures.js"

export { CONTROLLER_A, EPOCH_1, LEASE_1, PROJECT_ID, RUN_ID, WORKER_1, T0_MS, at, iso }

export const WORKER_2 = nodeIdSchema.parse("node-worker-2")
export const COMMAND_1 = commandIdSchema.parse("cmd-inbox-1")
export const DISPATCH_1 = "dispatch-inbox-1"
export const APPROVAL_1 = "approval-inbox-1"

const CONTROLLER_ACTOR = actorSchema.parse({ kind: "node", nodeId: CONTROLLER_A })

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

// --- Commands -------------------------------------------------------------

export interface ExecuteCommandOverrides {
  readonly commandId?: string
  readonly issuedAt?: string
  readonly expiresAt?: string
  /** Changes the instruction WITHOUT changing the command id: the conflict case. */
  readonly prompt?: string
  readonly dispatchId?: string
  readonly approvalId?: string
}

/**
 * A `dispatch.execute` command: the one type whose authorization cannot be
 * satisfied by a payload alone, so it is the type every authorization test uses.
 *
 * Built with a REAL envelope digest and a REAL approval bound to it. That
 * matters for the guard under test: the recorded-log step must refuse because
 * the LOG holds no such approval, not because the payload is internally
 * inconsistent. A forged-approval test that tripped a digest check first would
 * prove nothing about the rule it claims to cover.
 */
export function executeCommand(overrides: ExecuteCommandOverrides = {}): Record<string, unknown> {
  const commandId = overrides.commandId ?? COMMAND_1
  const dispatchId = overrides.dispatchId ?? DISPATCH_1
  const envelope = dispatchEnvelope(dispatchId, overrides.prompt ?? "Do the work")
  const digest = digestDispatchEnvelope(envelope)
  const command = orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    actor: CONTROLLER_ACTOR,
    controllerNodeId: CONTROLLER_A,
    controllerEpoch: EPOCH_1,
    leaseId: LEASE_1,
    issuedAt: overrides.issuedAt ?? iso(at(1)),
    expiresAt: overrides.expiresAt ?? iso(at(20)),
    correlationId: commandId,
    causation: null,
    type: "dispatch.execute",
    payload: {
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
        approvalId: overrides.approvalId ?? APPROVAL_1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        dispatchId,
        envelopeDigest: digest,
        decision: "approved",
        state: "approved",
        basis: { kind: "user" },
        actor: { kind: "user", userId: "user-1" },
        decidedAt: iso(at(0)),
      }),
    },
  })
  return commandEnvelopeFor(command, { commandId })
}

/**
 * The dispatch envelope a `dispatch.execute` carries.
 *
 * `controllerEpoch` is set from the shared `EPOCH_1` because
 * `orchestrationCommandSchema` cross-checks the envelope's epoch against the
 * command's. That check is a good one — an envelope decided under one epoch
 * launched under another is exactly the stale-epoch case — and a fixture that
 * omitted it would fail at the schema rather than at the guard under test, which
 * is the failure mode the lease fixtures' doc comment warns about.
 */
function dispatchEnvelope(dispatchId: string, prompt: string) {
  // Re-parsed with this directory's epoch. The shared fixture pins its own
  // `EPOCH`, and `orchestrationCommandSchema` cross-checks the envelope's epoch
  // against the command's — which is the right check (an envelope decided under
  // one epoch and launched under another is exactly the stale-epoch case) and
  // would otherwise fail at the schema rather than at the guard under test.
  // The scope and target node are NOT overridden: the shared fixture already
  // names this directory's project, run and worker, and a fixture that stated
  // them a second time would be a second source of truth for the same ids.
  const shared = makeEnvelope({ dispatchId, taskId: "task-inbox-1", attempt: 1, prompt })
  return dispatchEnvelopeSchema.parse({ ...shared, controllerEpoch: EPOCH_1 })
}

/** A `mesh.command` envelope around an already-minted kernel command. */
export function commandEnvelopeFor(
  command: ReturnType<typeof orchestrationCommandSchema.parse>,
  options: { readonly commandId: string },
): Record<string, unknown> {
  const minted = mintMeshCommand({ command, targetNodeId: WORKER_1 }) as unknown as Record<string, unknown>
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.command",
    messageId: `msg-${options.commandId}`,
    correlationId: options.commandId,
    causation: null,
    senderNodeId: CONTROLLER_A,
    recipientNodeId: WORKER_1,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(at(0)),
    expiresAt: iso(at(3600)),
    payload: minted,
  }
}

/** A `run.pause` command: no approval, no dispatch, so the simplest admission. */
export function pauseCommand(options: { readonly commandId?: string; readonly reason?: string; readonly issuedAt?: string } = {}): Record<string, unknown> {
  const commandId = options.commandId ?? "cmd-inbox-pause"
  const command = orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    actor: CONTROLLER_ACTOR,
    controllerNodeId: CONTROLLER_A,
    controllerEpoch: EPOCH_1,
    leaseId: LEASE_1,
    issuedAt: options.issuedAt ?? iso(at(1)),
    expiresAt: iso(at(20)),
    correlationId: commandId,
    causation: null,
    type: "run.pause",
    payload: { reason: options.reason ?? "operator asked" },
  })
  return commandEnvelopeFor(command, { commandId })
}

// --- The recorded log -----------------------------------------------------

export interface RecordedLogState {
  readonly approval: RecordedApproval | null
  readonly dispatch: RecordedDispatch | null
  readonly lease: RecordedLease | null
}

/** A lease the log DOES hold, so a lease refusal is a test's choice, not a default. */
export function aRecordedLease(overrides: Partial<RecordedLease> = {}): RecordedLease {
  return {
    leaseId: LEASE_1,
    controllerNodeId: CONTROLLER_A,
    epoch: EPOCH_1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    expiresAt: iso(at(30)),
    ...overrides,
  }
}

/**
 * A recorded lease that DIFFERS from the one the fixtures default to.
 *
 * Every id is branded through the kernel's own schema, for the reason every id
 * in this codebase is: a lease reader that received an unbranded string could
 * not tell a lease id from a project id, and the whole lease-scope check rests
 * on those being distinguishable types.
 */
export function aRecordedLeaseAt(options: {
  readonly epoch?: number
  readonly controllerNodeId?: string
  readonly runId?: string
  readonly projectId?: string
}): RecordedLease {
  return {
    leaseId: leaseIdSchema.parse(LEASE_1),
    controllerNodeId: nodeIdSchema.parse(options.controllerNodeId ?? CONTROLLER_A),
    epoch: options.epoch ?? EPOCH_1,
    projectId: projectIdSchema.parse(options.projectId ?? PROJECT_ID),
    runId: runIdSchema.parse(options.runId ?? RUN_ID),
    expiresAt: iso(at(30)),
  }
}

/**
 * The envelope digest a command WOULD launch.
 *
 * Read out of the minted record rather than recomputed from a re-minted
 * envelope, because recomputing would require minting a second envelope and a
 * second envelope is a DIFFERENT digest — a fixture that did that would be
 * testing a digest mismatch it had manufactured.
 */
export function envelopeDigestOf(envelope: Record<string, unknown>): string {
  const command = (envelope.payload as { readonly command: { readonly payload: { readonly dispatch: { readonly envelopeDigest: string } } } }).command
  return command.payload.dispatch.envelopeDigest
}

/**
 * A log that HOLDS the approval and dispatch a command names.
 *
 * The default log holds neither, which is the right default for a test about a
 * refusal and the wrong one for a test about anything else. Derived from the
 * envelope, so the recorded digest and the command's own envelope digest are the
 * same string by construction — which is exactly the precondition the
 * recorded-log step checks, and a fixture that hard-coded one would let a test
 * pass with a digest that happened to line up.
 */
export function licensingLog(envelope: Record<string, unknown>): FakeRecordedLog {
  const digest = envelopeDigestOf(envelope)
  return new FakeRecordedLog({
    approval: aRecordedApproval(digest),
    dispatch: aRecordedDispatch(digest),
  })
}

/**
 * An approval the log DOES hold, carrying the same digest as the command's
 * envelope.
 *
 * The envelope digest is supplied by the test because the fixture cannot derive
 * it: it lives inside the minted command, and a fixture that re-minted the
 * envelope to learn the digest would build a second envelope and therefore a
 * different digest — which is exactly the mismatch the recorded-log step is
 * supposed to catch.
 */
export function aRecordedApproval(envelopeDigest: string, overrides: Partial<RecordedApproval> = {}): RecordedApproval {
  return {
    approvalId: approvalIdSchema.parse(APPROVAL_1),
    state: "approved",
    decision: "approved",
    envelopeDigest: digestSchema.parse(envelopeDigest),
    dispatchId: dispatchIdSchema.parse(DISPATCH_1),
    ...overrides,
  }
}

export function aRecordedDispatch(envelopeDigest: string, overrides: Partial<RecordedDispatch> = {}): RecordedDispatch {
  return {
    dispatchId: dispatchIdSchema.parse(DISPATCH_1),
    state: "approved",
    envelopeDigest: digestSchema.parse(envelopeDigest),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    ...overrides,
  }
}

/**
 * A `RecordedLogReader` over a fixed state, plus a read counter.
 *
 * The counter is the point: "a refused command wrote nothing" is easy to assert
 * against the inbox and easy to assert against the LOG too, and the log is where
 * a buggy implementation would leak — an authorization that consulted the log and
 * then persisted anyway is invisible from the store alone if the store is also
 * where the bug lives.
 */
export class FakeRecordedLog implements RecordedLogReader {
  readonly reads: { approval: number; dispatch: number; lease: number } = { approval: 0, dispatch: 0, lease: 0 }
  #state: RecordedLogState

  /**
   * `undefined` means "not stated, use the default"; `null` means "the log
   * holds NO such record".
   *
   * The distinction is the whole point of this double, and collapsing it with
   * `??` would be the most damaging possible convenience: a test for "the log
   * never decided this approval" would silently get a log that HAS decided it,
   * and the test would pass for the wrong reason or fail confusingly. A test
   * that means "no approval" has to be able to say so.
   */
  constructor(state: Partial<RecordedLogState> = {}) {
    this.#state = {
      approval: state.approval === undefined ? null : state.approval,
      dispatch: state.dispatch === undefined ? null : state.dispatch,
      lease: state.lease === undefined ? aRecordedLease() : state.lease,
    }
  }

  /** Same rule as the constructor, so a test can withdraw a record mid-run. */
  set(next: Partial<RecordedLogState>): void {
    this.#state = { ...this.#state, ...next }
  }

  async approval(_approvalId: unknown) {
    this.reads.approval += 1
    return { ok: true as const, value: this.#state.approval }
  }

  async dispatch(_dispatchId: unknown) {
    this.reads.dispatch += 1
    return { ok: true as const, value: this.#state.dispatch }
  }

  async lease(_leaseId: unknown) {
    this.reads.lease += 1
    return { ok: true as const, value: this.#state.lease }
  }
}

// --- The gate -------------------------------------------------------------

/**
 * A gate that ADMITS, and records the order it was called in.
 *
 * The default admission runs the REAL `verifyIncomingCommand` rather than
 * handing back a bare `{ admitted: true }`. That is not a shortcut in the
 * convenient direction: `MeshCommandInbox` correctly refuses an admission with
 * no `verified` payload, so a stub gate that admitted nothing would make every
 * test in this directory stop at the gate and assert about nothing. Running the
 * protocol's own verification means a fixture whose digest, addressing or replay
 * window is wrong fails for the reason the protocol names, rather than being
 * papered over by a permissive double.
 *
 * `admit` is still injectable, for the one thing a test needs a hand in: a
 * command whose digest is DELIBERATELY broken.
 */
export class RecordingGate {
  readonly calls: string[] = []
  #admit: (value: unknown) => GateOutcomeLike

  constructor(admit?: (value: unknown) => GateOutcomeLike) {
    this.#admit = admit ?? verifyingAdmission
  }

  authorize = async (value: unknown): Promise<GateOutcomeLike> => {
    this.calls.push("gate")
    return this.#admit(value)
  }
}

/**
 * The default admission: parse through the one parse site, then verify.
 *
 * `safeParseMeshEnvelope` rather than a family schema, because M4-V's rule is
 * that there is exactly one parse entry point and a fixture that used another
 * would let a test pass against a record the gateway would never have produced.
 */
export function verifyingAdmission(value: unknown): GateOutcomeLike {
  const parsed = safeParseMeshEnvelope(value)
  if (!parsed.ok) {
    return { admitted: false, stage: "parse", reason: "not_a_command", error: parsed.error }
  }
  const envelope = parsed.value
  if (envelope.recordType !== "mesh.command") {
    return { admitted: false, stage: "parse", reason: "not_a_command", error: null as never }
  }
  const record = envelope.payload
  const verified = verifyIncomingCommand(record, {
    recipientNodeId: record.targetNodeId,
    controllerNodeId: record.controllerNodeId,
    projectId: record.projectId,
    runId: record.runId,
    acceptedEpoch: record.controllerEpoch,
    // The replay window is checked against a FIXED instant rather than the
    // harness clock. A test moves the clock to simulate a retry, and a command
    // minted at T+1 would be "not yet valid" at T — which is a correct refusal
    // of the wrong thing for a dedupe test. The window is M4.4's subject and
    // M4.4's tests own it.
    nowMs: at(1),
  })
  if (!verified.ok) {
    return { admitted: false, stage: "integrity", reason: verified.reason, error: verified.error }
  }
  return { admitted: true, stage: "admitted", verified: verified.value }
}

/** A gate that refuses, with a supplied stage and code. */
export function refusingGate(stage: string, code: string): RecordingGate {
  return new RecordingGate(() => ({
    admitted: false,
    stage,
    reason: code,
    error: {
      schemaVersion: 1,
      category: "policy_denied",
      code,
      message: `refused at ${stage}`,
      retryable: false,
    },
  }))
}

// --- The ack emitter ------------------------------------------------------

export interface EmittedAck {
  readonly ack: MeshAck
  readonly commandId: CommandId
  readonly acceptedSequence: number
  /** The rows visible at the instant the ack was handed over. */
  readonly rowsAtEmit: readonly InboxRow[]
}

/**
 * The ack emitter, and the evidence for "persisted BEFORE acknowledged".
 *
 * It reads the STORE from inside `emit` rather than being told what was written.
 * A test that asserted durability by checking the store after `submit` returned
 * would pass even if the ack had gone out first, because by then both had
 * happened; reading from inside the callback is the only moment the two are
 * distinguishable.
 */
export class RecordingAckEmitter {
  readonly emitted: EmittedAck[] = []
  #store: CommandInboxStore

  constructor(store: CommandInboxStore) {
    this.#store = store
  }

  emit = async (ack: MeshAck, context: { commandId: CommandId; acceptedSequence: number }): Promise<void> => {
    const listed = await this.#store.listInbox({})
    if (!listed.ok) throw new Error(`ack emitter could not read the store: ${listed.error.code}`)
    this.emitted.push({
      ack,
      commandId: context.commandId,
      acceptedSequence: context.acceptedSequence,
      rowsAtEmit: listed.value,
    })
  }

  /** The acks only, for a test asserting ORDER rather than content. */
  get order(): readonly string[] {
    return this.emitted.map((entry) => entry.ack.acksCommandId ?? "unattributed")
  }

  get outcomes(): readonly string[] {
    return this.emitted.map((entry) => entry.ack.outcome)
  }
}

// --- The seam under test --------------------------------------------------

export interface InboxHarness {
  readonly inbox: MeshCommandInbox
  readonly store: CommandInboxStore
  readonly gate: RecordingGate
  readonly log: FakeRecordedLog
  readonly acks: RecordingAckEmitter
  readonly clock: TestClock
  /** Every call the inbox's collaborators recorded, in order. */
  readonly trace: () => readonly string[]
  close(): void
  /** Every row, terminal or not. */
  rows(): Promise<readonly InboxRow[]>
  row(commandId: CommandId): Promise<InboxRow | null>
}

interface StoreKind {
  readonly label: string
  readonly make: (clock: TestClock) => { store: CommandInboxStore; close: () => void }
}

/**
 * BOTH implementations of the write port.
 *
 * A semantic drift between them is the defect this pairing exists to prevent,
 * and the drift only shows up under concurrency — so a suite that tests one
 * implementation and calls the port covered is making a claim it has not
 * checked. The SQLite one is a real database with the inbox's own migrations
 * run against it, not a Map with a different name.
 */
export const INBOX_STORE_KINDS: readonly StoreKind[] = [
  { label: "InMemoryCommandInboxStore", make: () => ({ store: new InMemoryCommandInboxStore(), close: () => undefined }) },
  {
    label: "SqliteCommandInboxStore",
    make: (clock) => {
      const driver = openInMemoryDriver()
      // The KERNEL's migrations too: the inbox reads nothing from them, but a
      // worker database has both, and a test that only ran the inbox's would
      // not catch a fixture that quietly depended on their absence.
      runMigrations(driver)
      runMeshInboxMigrations(driver, { now: clock.now })
      return { store: new SqliteCommandInboxStore(driver), close: () => driver.close() }
    },
  },
]

export function makeInboxHarness(
  clock: TestClock,
  store: CommandInboxStore,
  options: {
    readonly gate?: RecordingGate
    readonly log?: FakeRecordedLog
    readonly authenticated?: NodeId | null
  } = {},
  close: () => void = () => undefined,
): InboxHarness {
  const gate = options.gate ?? new RecordingGate()
  const log = options.log ?? new FakeRecordedLog()
  const acks = new RecordingAckEmitter(store)
  const trace: string[] = []
  const authenticated = options.authenticated === undefined ? CONTROLLER_A : options.authenticated

  // A store wrapper that records every write, so the ordering assertion reads one
  // sequence rather than correlating a store spy with an emitter spy.
  const traced: CommandInboxStore = {
    async accept(row) {
      trace.push("persist")
      return store.accept(row)
    },
    async find(commandId) {
      trace.push("dedupe")
      return store.find(commandId)
    },
    async listInbox(filter) {
      return store.listInbox(filter)
    },
    async countInbox(filter) {
      return store.countInbox(filter)
    },
    async markRuntimeAccepted(commandId, now) {
      trace.push("runtime_accept")
      return store.markRuntimeAccepted(commandId, now)
    },
    async recordResult(commandId, result, now) {
      trace.push("record_result")
      return store.recordResult(commandId, result, now)
    },
    async markAckEmitted(commandId, now) {
      trace.push("mark_ack")
      return store.markAckEmitted(commandId, now)
    },
    async nextAcceptedSequence() {
      return store.nextAcceptedSequence()
    },
  }

  const inbox = new MeshCommandInbox({
    store: traced,
    authenticate: {
      authenticate: async () => {
        trace.push("authenticate")
        if (authenticated === null) {
          return {
            ok: false as const,
            error: {
              schemaVersion: 1 as const,
              category: "policy_denied" as const,
              code: "identity.revoked",
              message: "The node's identity is revoked.",
              retryable: false,
            },
          }
        }
        return { ok: true as const, value: { nodeId: authenticated } }
      },
    },
    gate: {
      authorize: async (value: unknown) => {
        trace.push("gate")
        return gate.authorize(value)
      },
    },
    recordedLog: {
      approval: (id) => {
        trace.push("log.approval")
        return log.approval(id)
      },
      dispatch: (id) => {
        trace.push("log.dispatch")
        return log.dispatch(id)
      },
      lease: (id) => {
        trace.push("log.lease")
        return log.lease(id)
      },
    },
    acks: {
      emit: async (ack, context) => {
        trace.push("ack")
        return acks.emit(ack, context)
      },
    },
    now: clock.now,
  })

  return {
    inbox,
    store,
    gate,
    log,
    acks,
    clock,
    trace: () => trace,
    close,
    async rows() {
      const listed = await store.listInbox({})
      if (!listed.ok) throw new Error(`fixture row read failed: ${listed.error.code}`)
      return listed.value
    },
    async row(commandId: CommandId) {
      const found = await store.find(commandId)
      if (!found.ok) throw new Error(`fixture row read failed: ${found.error.code}`)
      return found.value
    },
  }
}

export function memoryInboxHarness(clock: TestClock, options: Parameters<typeof makeInboxHarness>[2] = {}): InboxHarness {
  const store = new InMemoryCommandInboxStore()
  return makeInboxHarness(clock, store, options)
}

export function durableInboxHarness(clock: TestClock, options: Parameters<typeof makeInboxHarness>[2] = {}): InboxHarness {
  const driver = openInMemoryDriver()
  runMigrations(driver)
  runMeshInboxMigrations(driver, { now: clock.now })
  return makeInboxHarness(clock, new SqliteCommandInboxStore(driver), options, () => driver.close())
}

/** Both harnesses, so a semantic drift between the two stores is a failure. */
export function bothInboxHarnesses(
  clock: TestClock,
  options: Parameters<typeof makeInboxHarness>[2] = {},
): { label: string; make: () => InboxHarness }[] {
  return [
    { label: "InMemoryCommandInboxStore", make: () => memoryInboxHarness(clock, options) },
    { label: "SqliteCommandInboxStore", make: () => durableInboxHarness(clock, options) },
  ]
}

export type { CommandInboxOutcome, InboxRow, CommandInboxStore, SqliteDriver }

/**
 * M4.5 outbox test fixtures.
 *
 * Built on the PROTOCOL's own `mintMeshEvent` and `meshEventSchema`, never on a
 * hand-written event. A hand-written `mesh.event` would let a test pass against a
 * record the gateway would never have produced, and the whole subject of this
 * directory is whether the bytes that leave this node are the bytes the
 * controller can parse.
 *
 * Nothing reads a clock. Every instant is `T0` plus a number, and the clock is a
 * closure the test moves by hand, because the subject is the backoff schedule
 * and the crash boundaries — and a fixture that called `Date.now()` would turn
 * both into a sleep.
 *
 * The store under test is ALWAYS durable SQLite, via a real file. The kernel's
 * `outbox_records` table is where the claim transaction, the `attempts` increment
 * and the stale-claim reclamation live, and an in-memory double would be a
 * re-implementation of all three.
 */
import { commandIdSchema, eventIdSchema, nodeIdSchema, type EventId } from "../../../../src/orchestration/identifiers.js"
import { orchestrationEventSchema, sessionSchema } from "../../../../src/orchestration/schemas.js"
import { mintMeshEvent, type MeshEvent } from "../../../../src/mesh/protocol/event.js"
import { meshAckSchema, type MeshAck } from "../../../../src/mesh/protocol/ack.js"
import { DurableEventOutbox } from "../../../../src/mesh/outbox/outbox.js"
import { OutboxDeliverer } from "../../../../src/mesh/outbox/deliverer.js"
import { SqliteEventOutboxStore } from "../../../../src/mesh/outbox/sqlite-outbox-store.js"
import type { EventOutboxStore, MeshOutboxEntry } from "../../../../src/mesh/outbox/types.js"
import { durable, removeFiles, reopen, type Database } from "./helpers.js"

export { durable, removeFiles, reopen, type Database }

export const WORKER = nodeIdSchema.parse("node-worker-1")
export const CONTROLLER = nodeIdSchema.parse("node-controller-a")
export const PROJECT = "project-release"
export const RUN = "run-release-1"
export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0_MS + seconds * 1000
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

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

// --- Events ---------------------------------------------------------------

export interface EventOverrides {
  readonly eventId?: string
  readonly localSequence?: number
  readonly occurredAt?: number
  readonly commandCorrelation?: string | null
  readonly type?: "dispatch.started" | "dispatch.finished" | "session.observed"
}

/**
 * A `mesh.event`, minted through the protocol's own seam.
 *
 * The event id and the local sequence are supplied rather than derived, because
 * both properties under test need them chosen: a redelivery must reuse the id, a
 * gap must skip the sequence, and a fixture that numbered them for me would make
 * both unexpressible.
 */
export function aMeshEvent(overrides: EventOverrides = {}): MeshEvent {
  const eventId = eventIdSchema.parse(overrides.eventId ?? "evt-outbox-1")
  const commandCorrelation =
    overrides.commandCorrelation === undefined
      ? commandIdSchema.parse("cmd-outbox-1")
      : overrides.commandCorrelation === null
        ? null
        : commandIdSchema.parse(overrides.commandCorrelation)
  const event = orchestrationEventSchema.parse({
    schemaVersion: 1,
    eventId,
    // The kernel's per-RUN sequence, which is a different axis from the mesh's
    // per-NODE `localSequence`. A worker reporting an event it observed does not
    // know the controller's run position, so it is supplied rather than derived;
    // what the outbox and the ingestion dedupe key on is `eventId` and
    // `localSequence`, and this number is carried because the kernel schema
    // requires it rather than because anything here reads it.
    sequence: overrides.localSequence ?? 1,
    projectId: PROJECT,
    runId: RUN,
    occurredAt: iso(overrides.occurredAt ?? at(1)),
    actor: { kind: "node", nodeId: WORKER },
    correlationId: eventId,
    causation: commandCorrelation === null ? null : { kind: "command", commandId: commandCorrelation },
    controllerEpoch: 1,
    ...(commandCorrelation === null ? {} : { commandId: commandCorrelation }),
    type: overrides.type ?? "dispatch.started",
    // `dispatch.started` and `session.observed` both carry a FULL `session`, and
    // `orchestrationEventSchema` cross-checks the session's own scope against the
    // event's. `sessionSchema.parse` rather than a literal, for the reason every
    // fixture in this codebase is: a hand-built session that satisfies the shape
    // at runtime and not at compile time is a fixture whose negative tests can be
    // satisfied by a record the wire would refuse.
    payload:
      overrides.type === "dispatch.finished"
        ? { dispatchId: "dispatch-outbox-1", outcome: "completed" }
        : {
            session: sessionSchema.parse({
              schemaVersion: 1,
              sessionId: "sess-outbox-1",
              projectId: PROJECT,
              runId: RUN,
              taskId: "task-outbox-1",
              dispatchId: "dispatch-outbox-1",
              nodeId: WORKER,
              installationId: "install-outbox-1",
              runtimeKind: "opencode",
              lifecycleState: overrides.type === "session.observed" ? "running" : "launching",
              observedState: overrides.type === "session.observed" ? "working" : "starting",
            }),
          },
  })
  return mintMeshEvent({
    event,
    sourceNodeId: WORKER,
    localSequence: overrides.localSequence ?? 1,
    commandCorrelation,
  })
}

/** A `mesh.event` ENVELOPE, built raw and left for the receiver's parse. */
export function eventEnvelope(event: MeshEvent): Record<string, unknown> {
  return {
    schemaVersion: 2,
    recordType: "mesh.event",
    messageId: `msg-${event.eventId}`,
    correlationId: event.eventId,
    causation: null,
    senderNodeId: event.sourceNodeId,
    recipientNodeId: CONTROLLER,
    protocolVersion: event.meshProtocolVersion,
    issuedAt: event.observedAt,
    expiresAt: iso(at(3600)),
    payload: event,
  }
}

// --- The transport --------------------------------------------------------

export type TransportMode = "accept" | "reject" | "throw"

/**
 * A transport that answers with a real `mesh.ack`.
 *
 * An ack, not a boolean, because the ack is the ONLY thing that retires an
 * outbox record — a transport that returned `true` would make "the write
 * succeeded" indistinguishable from "the controller persisted it", which is
 * exactly the distinction the plan's "remains until controller acknowledgement
 * is persisted" turns on.
 *
 * `sent` accumulates every transmission, so a test can assert that a redelivery
 * actually reached the wire rather than inferring it from a status column.
 */
export class FakeTransport {
  readonly sent: MeshOutboxEntry[] = []
  readonly acks: MeshAck[] = []
  /** The instant each transmission was made, for the "before send" boundary. */
  readonly sentAt: number[] = []
  #mode: TransportMode
  #now: () => number
  #onSend: ((entry: MeshOutboxEntry) => void) | null = null

  constructor(now: () => number, mode: TransportMode = "accept") {
    this.#now = now
    this.#mode = mode
  }

  setMode(mode: TransportMode): void {
    this.#mode = mode
  }

  /**
   * Runs a callback inside `send`, after the record is on the wire and before the
   * ack comes back. The hook-6 crash window is this point, and it is a CALLBACK
   * rather than a flag so a test can throw from exactly there without the
   * production code knowing tests exist.
   */
  onSend(callback: ((entry: MeshOutboxEntry) => void) | null): void {
    this.#onSend = callback
  }

  send = async (entry: MeshOutboxEntry): Promise<MeshAck> => {
    this.sent.push(entry)
    this.sentAt.push(this.#now())
    this.#onSend?.(entry)
    if (this.#mode === "throw") throw new Error("ECONNRESET: the peer went away mid-write")
    const acknowledgedAt = iso(this.#now())
    const ack =
      this.#mode === "reject"
        ? meshAckSchema.parse({
            acksEventId: entry.eventId,
            ackKind: "event",
            acknowledgedAt,
            outcome: "rejected",
            rejectionCode: "not_authorized",
          })
        : meshAckSchema.parse({
            acksEventId: entry.eventId,
            ackKind: "event",
            acknowledgedAt,
            outcome: "accepted",
          })
    this.acks.push(ack)
    return ack
  }

  /** The event ids that reached the wire, in order. */
  get sentEventIds(): readonly EventId[] {
    return this.sent.map((entry) => entry.eventId)
  }
}

// --- The boundary ---------------------------------------------------------

/**
 * M4-B hooks 5 and 6, as a recorder that can also CRASH at either one.
 *
 * `crashAt` throws from inside the hook, which is how a test models a process
 * that died at that exact instant: the claim is already durable, the delivery is
 * already recorded, and nothing after the hook runs. Throwing rather than
 * returning a sentinel is deliberate — a sentinel would let the pump carry on, and
 * the crash would not be a crash.
 */
export class RecordingBoundary {
  readonly calls: string[] = []
  readonly #crashAt: "beforeDeliver" | "afterRuntimeAccept" | null
  crashCount = 0

  constructor(crashAt: "beforeDeliver" | "afterRuntimeAccept" | null = null) {
    this.#crashAt = crashAt
  }

  beforeDeliver = (outboxId: string): void => {
    this.calls.push(`beforeDeliver:${outboxId}`)
    if (this.#crashAt === "beforeDeliver") {
      this.crashCount += 1
      throw new Error(`crash injected at EffectBoundary.beforeDeliver for '${outboxId}'`)
    }
  }

  afterRuntimeAccept = (outboxId: string): void => {
    this.calls.push(`afterRuntimeAccept:${outboxId}`)
    if (this.#crashAt === "afterRuntimeAccept") {
      this.crashCount += 1
      throw new Error(`crash injected at EffectBoundary.afterRuntimeAccept for '${outboxId}'`)
    }
  }

  reset(): void {
    this.calls.length = 0
    this.crashCount = 0
  }
}

// --- The seam under test --------------------------------------------------

export interface OutboxHarness {
  readonly outbox: DurableEventOutbox
  readonly store: EventOutboxStore
  readonly db: Database
  readonly clock: TestClock
  readonly transport: FakeTransport
  /** A NEW deliverer over the SAME database. What a restart looks like. */
  deliverer(options?: { readonly boundary?: RecordingBoundary }): OutboxDeliverer
  close(): void
}

export function outboxHarness(
  clock: TestClock = new TestClock(at(0)),
  transport: FakeTransport = new FakeTransport(clock.now),
): OutboxHarness {
  const db = durable("mesh-outbox")
  const store = new SqliteEventOutboxStore(db.driver)
  return {
    outbox: new DurableEventOutbox({ store, now: clock.now }),
    store,
    db,
    clock,
    transport,
    deliverer: (options = {}) =>
      new OutboxDeliverer({
        store,
        transport,
        now: clock.now,
        ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
      }),
    close: () => db.remove(),
  }
}

/**
 * A harness whose DATABASE FILE outlives a "restart".
 *
 * `stop` closes the handle and removes nothing; `start` reopens the SAME PATH.
 * That is the only shape in which a restart assertion means anything: an
 * in-memory store that survived would be testing nothing, and one that did not
 * survive would be testing a cache. A worker that forgets an acknowledged event
 * on restart is the failure this exists to catch.
 */
export class RestartableOutbox {
  readonly clock: TestClock
  readonly transport: FakeTransport
  readonly path: string
  #db: Database | null = null
  #store: SqliteEventOutboxStore | null = null

  constructor(clock: TestClock = new TestClock(at(0)), transport?: FakeTransport) {
    this.clock = clock
    this.transport = transport ?? new FakeTransport(clock.now)
    const first = durable("mesh-outbox-restart")
    this.path = first.path
    this.#db = first
    this.#store = new SqliteEventOutboxStore(first.driver)
  }

  /** The live seam. Throws if the process is "down". */
  get harness(): OutboxHarness {
    const db = this.#db
    const store = this.#store
    if (db === null || store === null) throw new Error("the harness is stopped; call start()")
    return {
      outbox: new DurableEventOutbox({ store, now: this.clock.now }),
      store,
      db,
      clock: this.clock,
      transport: this.transport,
      deliverer: (options = {}) =>
        new OutboxDeliverer({
          store,
          transport: this.transport,
          now: this.clock.now,
          ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
        }),
      close: () => undefined,
    }
  }

  /** The process died. The file stays. */
  stop(): void {
    this.#db?.close()
    this.#db = null
    this.#store = null
  }

  /** The process restarted: a fresh connection to the same file. */
  start(): void {
    if (this.#db !== null) return
    this.#db = reopen(this.path)
    this.#store = new SqliteEventOutboxStore(this.#db.driver)
  }

  /** Restart, in the order a process does it. */
  restart(): void {
    this.stop()
    this.start()
  }

  /** Removes the file. Not a restart — the end of the test. */
  destroy(): void {
    this.stop()
    removeFiles(this.path)
  }
}

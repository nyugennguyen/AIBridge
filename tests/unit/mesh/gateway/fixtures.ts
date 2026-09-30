/**
 * M4.6 test fixtures.
 *
 * Three rules, each of which exists because breaking it produced a test that passed
 * for the wrong reason at some point during an earlier milestone:
 *
 *   1. **Nothing here reads a clock.** Every instant is `T0` plus a number, and the
 *      clock is a closure the test moves by hand. The subjects of this directory
 *      are "an hour after the retention window closed" and "a resume from a cursor
 *      the gateway can no longer honour" — a fixture that called `Date.now()` would
 *      make both a sleep, and a sleeping test passes on a slow machine and fails on
 *      a fast one.
 *   2. **Every record is built through the protocol's own minting seam** where one
 *      exists, and through the kernel's own schemas where one does not. A
 *      hand-written `mesh.event` would let a test pass against bytes the gateway
 *      would never have produced, and the whole subject of this directory is
 *      whether what goes in is what comes out.
 *   3. **Branded ids are PARSED, never cast.** A fixture that laundered a string
 *      into a brand would let a test pass against an id no peer could address,
 *      which is the exact class of defect the brands exist to prevent.
 */
import { SqliteEventStore } from "../../../../src/orchestration/event-store/event-store.js"
import type { StoredRunEvent } from "../../../../src/orchestration/event-store/types.js"
import {
  commandIdSchema,
  dispatchIdSchema,
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  type NodeId,
} from "../../../../src/orchestration/identifiers.js"
import { orchestrationEventSchema, sessionSchema } from "../../../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../../../src/orchestration/types.js"
import { revisedSameDispatchId } from "../../orchestration/fixtures/recorded-events.js"
import { makeCommand } from "../../event-store/fixtures.js"
import { mintMeshEvent, type MeshEvent } from "../../../../src/mesh/protocol/event.js"
import { reconcileIdSchema } from "../../../../src/mesh/protocol/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import type { ReconcileContext } from "../../../../src/mesh/protocol/reconciliation.js"

export const CONTROLLER = nodeIdSchema.parse("node-controller-1")
export const WORKER = nodeIdSchema.parse("node-worker-1")
export const OTHER_WORKER = nodeIdSchema.parse("node-worker-2")
export const PROJECT = projectIdSchema.parse("project-release")
export const OTHER_PROJECT = projectIdSchema.parse("project-other")
export const RUN = runIdSchema.parse("run-release-1")
export const OTHER_RUN = runIdSchema.parse("run-release-2")
export const EPOCH = 4
export const PROTOCOL_VERSION = CURRENT_MESH_PROTOCOL_VERSION

export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0_MS + seconds * 1000
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * A clock the test moves by hand.
 *
 * Exposes the function AND the setter, because the retention-age bound and the
 * cursor-ahead case both need the clock to move BACKWARDS relative to when an event
 * was accepted, and a forward-only `tick()` cannot express either.
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

/** The reconcile context, defaulted to the shapes the protocol tests use. */
export function context(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    supportedProtocolVersions: [PROTOCOL_VERSION],
    acceptedControllerEpoch: EPOCH,
    nowMs: at(0),
    ...overrides,
  }
}

// --- Events ---------------------------------------------------------------

export interface EventOverrides {  readonly eventId?: string
  readonly localSequence?: number
  readonly occurredAt?: number
  readonly type?: "dispatch.started" | "dispatch.finished" | "session.observed"
  readonly projectId?: string
  readonly runId?: string
  readonly sessionId?: string
  readonly dispatchId?: string
  readonly nodeId?: NodeId
  /**
   * The KERNEL's per-run sequence, which is a THIRD axis.
   *
   * Separate from `localSequence` because the property that `position` is not
   * derived from either of them is only observable when the two disagree, and a
   * fixture that derived one from the other would make that test pass for the wrong
   * reason.
   */
  readonly runSequence?: number
}

/**
 * A `mesh.event`, minted through the protocol's own seam.
 *
 * The id and the local sequence are supplied rather than derived, because both
 * properties under test need them CHOSEN: a redelivery must reuse the id, a gap
 * must skip the sequence, and a fixture that numbered them would make both
 * unexpressible. The same is true of the kernel's own `sequence`, which is a THIRD
 * axis — per-run, against the gateway's cross-run `position` and the mesh's
 * per-source `localSequence` — and a fixture that conflated them would make the
 * ordering tests prove something about the wrong number.
 */
export function aMeshEvent(overrides: EventOverrides = {}): MeshEvent {
  const eventId = eventIdSchema.parse(overrides.eventId ?? "evt-gateway-1")
  const sourceNodeId = overrides.nodeId ?? WORKER
  const dispatchId = overrides.dispatchId ?? "dispatch-gateway-1"
  const commandId = commandIdSchema.parse(`cmd-${dispatchId}`)
  const event = orchestrationEventSchema.parse({
    schemaVersion: 1,
    eventId,
    // The kernel's per-RUN sequence, distinct from the mesh's per-NODE
    // `localSequence` and from the gateway's `position`. It is carried because the
    // schema requires it, not because anything in this directory orders by it — and
    // it is settable independently so a test can make the three disagree.
    sequence: overrides.runSequence ?? overrides.localSequence ?? 1,
    projectId: overrides.projectId ?? PROJECT,
    runId: overrides.runId ?? RUN,
    occurredAt: iso(overrides.occurredAt ?? at(1)),
    actor: { kind: "node", nodeId: sourceNodeId },
    correlationId: eventId,
    causation: { kind: "command", commandId },
    controllerEpoch: EPOCH,
    commandId,
    type: overrides.type ?? "dispatch.started",
    payload:
      overrides.type === "dispatch.finished"
        ? { dispatchId, outcome: "completed" }
        : {
            session: sessionSchema.parse({
              schemaVersion: 1,
              sessionId: overrides.sessionId ?? "sess-gateway-1",
              projectId: overrides.projectId ?? PROJECT,
              runId: overrides.runId ?? RUN,
              taskId: "task-gateway-1",
              dispatchId,
              nodeId: sourceNodeId,
              installationId: "install-gateway-1",
              runtimeKind: "opencode",
              lifecycleState: overrides.type === "session.observed" ? "running" : "launching",
              observedState: overrides.type === "session.observed" ? "working" : "starting",
            }),
          },
  })
  return mintMeshEvent({ event, sourceNodeId, localSequence: overrides.localSequence ?? 1, commandCorrelation: commandId })
}

/**
 * A `mesh.event` ENVELOPE, built raw and left for the gateway's parse.
 *
 * Raw on purpose: a fixture that parsed first would let a negative test pass for
 * the wrong reason, because the record would already be valid by the time the seam
 * was asked to refuse it.
 */
export function eventEnvelope(event: MeshEvent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  }
}

// --- Reconciliation records ------------------------------------------------

export interface ReconcileRequestOverrides extends Record<string, unknown> {
  readonly reconcileId?: string
  readonly projectId?: string
  readonly runId?: string
  readonly controllerNodeId?: string
  readonly controllerEpoch?: number
  readonly peerNodeId?: string
  readonly peerProtocolVersions?: readonly number[]
  readonly controllerLastAcknowledgedInboxSequence?: number
  readonly controllerLastAcknowledgedOutboxSequence?: number
  readonly observedAt?: string
  readonly activeSessionInventory?: readonly { sessionId: string; dispatchId: string; startedAt: string }[]
  /**
   * Envelope-level overrides, spread LAST.
   *
   * Separate from the payload overrides because a version-mismatch test needs to
   * break the ENVELOPE's `schemaVersion` while leaving the payload valid: feeding a
   * `schemaVersion` through the payload overrides would produce a record the family
   * refuses for two reasons at once, and the test would prove less than it claims.
   */
  readonly envelope?: Record<string, unknown>
}

/**
 * A `mesh.reconciliation.request` envelope, raw.
 *
 * The family binds `correlationId` to `reconcileId` and `recipientNodeId` to
 * `peerNodeId`, so the fixture derives all three from the same overrides rather
 * than letting a test set one and not the others — a fixture that could produce an
 * envelope the family would refuse for an unrelated reason makes every negative
 * test in this directory ambiguous.
 */
export function reconcileRequestEnvelope(overrides: ReconcileRequestOverrides = {}): Record<string, unknown> {
  const reconcileId = overrides.reconcileId ?? "rec-1"
  const peerNodeId = overrides.peerNodeId ?? WORKER
  return {
    schemaVersion: 2,
    recordType: "mesh.reconciliation.request",
    messageId: `msg-${reconcileId}`,
    correlationId: reconcileId,
    causation: null,
    senderNodeId: overrides.controllerNodeId ?? CONTROLLER,
    recipientNodeId: peerNodeId,
    protocolVersion: PROTOCOL_VERSION,
    issuedAt: overrides.observedAt ?? iso(at(1)),
    expiresAt: iso(at(3600)),
    payload: {
      reconcileId,
      projectId: overrides.projectId ?? PROJECT,
      runId: overrides.runId ?? RUN,
      controllerNodeId: overrides.controllerNodeId ?? CONTROLLER,
      controllerEpoch: overrides.controllerEpoch ?? EPOCH,
      peerNodeId,
      peerProtocolVersions: overrides.peerProtocolVersions ?? [PROTOCOL_VERSION],
      controllerLastAcknowledgedInboxSequence: overrides.controllerLastAcknowledgedInboxSequence ?? 0,
      controllerLastAcknowledgedOutboxSequence: overrides.controllerLastAcknowledgedOutboxSequence ?? 0,
      observedAt: overrides.observedAt ?? iso(at(1)),
      activeSessionInventory:
        overrides.activeSessionInventory ?? [{ sessionId: "sess-gateway-1", dispatchId: "dispatch-gateway-1", startedAt: iso(at(0)) }],
    },
    ...(overrides.envelope ?? {}),
  }
}

/** The projection engine's own event, as the event store returns it. */
export function aStoredEvent(
  event: MeshEvent,
  overrides: Partial<{ sequence: number; globalPosition: number }> = {},
): StoredRunEvent {
  const kernel = event.event
  return {
    ...kernel,
    sequence: overrides.sequence ?? kernel.sequence,
    globalPosition: overrides.globalPosition ?? kernel.sequence,
    event: kernel,
  }
}

/** A real migrated kernel store, in memory. The snapshot policy is tested against it. */
export function aKernelStore(): SqliteEventStore {
  return SqliteEventStore.createInMemory()
}

/**
 * A three-event run log, built through the kernel's own `EventRecorder`.
 *
 * The kernel's fixtures rather than a hand-built array, because the event
 * SCHEMA binds a `dispatch.started` to a full `session` and to its own run scope:
 * a hand-written log would either fail to parse for a reason that has nothing to do
 * with the property under test, or parse because the fixture left out the field that
 * would have caught it.
 */
export function aRunLog(): readonly OrchestrationEvent[] {
  return revisedSameDispatchId().slice(0, 3)
}

/** The command that appends {@link aRunLog}, in the shape `SqliteEventStore.append` takes. */
export function aRunCreateCommand(): OrchestrationCommand {
  // The event-store's own command fixture, not a hand-built one. `append` parses the
  // command through `orchestrationCommandSchema`, and a hand-built command that
  // satisfied it would be a second place to learn that schema's shape — with a
  // `run.pause` payload's required `reason` and `causation` as the first casualty.
  return makeCommand({ commandId: "cmd-append-run-log", projectId: PROJECT, runId: RUN, epoch: EPOCH })
}

/** Convenience for the ids the reconcile fixtures hand around. */
export const IDS = {
  command: (name: string) => commandIdSchema.parse(name),
  /** A `reconcileId`, which is a wire-only id with its own grammar in `protocol/`. */
  reconcile: (name: string) => reconcileIdSchema.parse(name),
  dispatch: (name: string) => dispatchIdSchema.parse(name),
  event: (name: string) => eventIdSchema.parse(name),
  session: (name: string) => sessionIdSchema.parse(name),
  project: (name: string) => projectIdSchema.parse(name),
  run: (name: string) => runIdSchema.parse(name),
  node: (name: string) => nodeIdSchema.parse(name),
  timestamp: (ms: number) => timestampSchema.parse(iso(ms)),
}

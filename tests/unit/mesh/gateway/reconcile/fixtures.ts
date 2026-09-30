/**
 * M4.6 — reconciliation fixtures.
 *
 * The reconciler's collaborators are fakes, and each fake is a port M4.4 / M4.5 /
 * the controller own rather than something the reconciler computes. They are built
 * so a test can say which storage question was asked and in what order — the
 * property under test is that a superseded controller causes NO durable read at all,
 * and a fake that answered from a `Map` without recording would make that
 * unobservable.
 */
import { commandIdSchema, dispatchIdSchema, epochSchema, eventIdSchema, nodeIdSchema, sessionIdSchema, type NodeId } from "../../../../../src/orchestration/identifiers.js"
import { createContractError, type Result } from "../../../../../src/orchestration/errors.js"
import type { LeaseScope } from "../../../../../src/mesh/lease/schemas.js"
import type { CommandId, EventId } from "../../../../../src/orchestration/identifiers.js"
import type {
  DispatchProjectionReader,
  ReconcileLeaseReader,
  UnacknowledgedSource,
} from "../../../../../src/mesh/gateway/reconcile/index.js"
import { CONTROLLER, EPOCH, OTHER_WORKER, PROJECT, RUN, WORKER, at, iso } from "../fixtures.js"

export const SCOPE: LeaseScope = { projectId: PROJECT, runId: RUN }

export interface ReadRecord {
  readonly store: "lease" | "inbox" | "outbox" | "projection"
  readonly scope: LeaseScope
  /** The cursor the caller passed, where the store is cursor-driven. */
  readonly after?: number
}

/**
 * M4.4's lease, as a two-method read.
 *
 * `reads` is the whole point: the reconciler is required to establish the accepted
 * epoch from the lease BEFORE it touches a queue, and a fake that could not show
 * the order could not show that.
 */
export class FakeLease implements ReconcileLeaseReader {
  readonly reads: ReadRecord[] = []
  readonly unreconciledWrites: { readonly scope: LeaseScope; readonly nodeIds: readonly NodeId[] }[] = []
  #epoch: number | null
  #failWith: Result<never> | null = null

  constructor(epoch: number | null = EPOCH) {
    this.#epoch = epoch
  }

  heldLease(scope: LeaseScope): Promise<Result<{ readonly epoch: ReturnType<typeof epochSchema.parse> } | null>> {
    this.reads.push({ store: "lease", scope })
    if (this.#failWith !== null) return Promise.resolve(this.#failWith)
    return Promise.resolve({ ok: true, value: this.#epoch === null ? null : { epoch: epochSchema.parse(this.#epoch) } })
  }

  setUnreconciledNodeIds(scope: LeaseScope, nodeIds: readonly NodeId[]): void {
    // A copy, because the reconciler may hold on to the array it passed and a fake
    // that aliased it would let a later mutation rewrite history.
    this.unreconciledWrites.push({ scope, nodeIds: Object.freeze([...nodeIds]) })
  }

  /** Moves the lease, which is what a takeover does. */
  setEpoch(epoch: number | null): void {
    this.#epoch = epoch
  }

  failWith(error: Result<never> | null): void {
    this.#failWith = error
  }

  /** The stores consulted, in order, which is the ordering assertion. */
  get storesRead(): readonly string[] {
    return this.reads.map((read) => read.store)
  }
}

/**
 * M4.5's durable queues, as step 4's two resend lists.
 *
 * Ids and never payloads, because that is what makes a resend idempotent: the
 * receiver dedupes on `commandId` / `eventId`, so a resend of something already
 * applied converges instead of appending a second thing that happened. A fake that
 * returned payloads would let a test pass against a resend the receiver cannot
 * dedupe.
 */
export class FakeUnacknowledged implements UnacknowledgedSource {
  readonly reads: ReadRecord[] = []
  #commands: CommandId[] = []
  #events: EventId[] = []
  #failWith: Result<never> | null = null

  seed(commands: string[] = [], events: string[] = []): this {
    this.#commands = commands.map((id) => commandIdSchema.parse(id))
    this.#events = events.map((id) => eventIdSchema.parse(id))
    return this
  }

  failWith(error: Result<never> | null): void {
    this.#failWith = error
  }

  async commandIds(scope: LeaseScope, afterInboxSequence: number, limit: number): Promise<Result<readonly CommandId[]>> {
    this.reads.push({ store: "inbox", scope, after: afterInboxSequence })
    if (this.#failWith !== null) return this.#failWith
    return { ok: true, value: this.#commands.slice(0, limit) }
  }

  async eventIds(scope: LeaseScope, afterOutboxSequence: number, limit: number): Promise<Result<readonly EventId[]>> {
    this.reads.push({ store: "outbox", scope, after: afterOutboxSequence })
    if (this.#failWith !== null) return this.#failWith
    return { ok: true, value: this.#events.slice(0, limit) }
  }
}

/**
 * The controller's dispatch projections, as step 5's other side of the diff.
 *
 * Keyed by `dispatchId`, and returning a `SessionId` rather than a whole dispatch.
 * The narrowness is the point and is explained on the port: a diff that compared
 * envelopes would report a revision as a divergence every time one happened (R3
 * replaces the envelope), and an operator who saw `unreconciled` entries on every
 * revision would learn to read them as "nothing important".
 */
export class FakeProjections implements DispatchProjectionReader {
  readonly reads: ReadRecord[] = []
  readonly #byDispatch = new Map<string, string>()
  #failWith: Result<never> | null = null

  seed(entries: { readonly dispatchId: string; readonly sessionId: string }[]): this {
    this.#byDispatch.clear()
    for (const entry of entries) this.#byDispatch.set(entry.dispatchId, entry.sessionId)
    return this
  }

  failWith(error: Result<never> | null): void {
    this.#failWith = error
  }

  async sessionForDispatch(scope: LeaseScope, dispatchId: ReturnType<typeof dispatchIdSchema.parse>): Promise<Result<ReturnType<typeof sessionIdSchema.parse> | null>> {
    this.reads.push({ store: "projection", scope })
    if (this.#failWith !== null) return this.#failWith
    const found = this.#byDispatch.get(dispatchId)
    return { ok: true, value: found === undefined ? null : sessionIdSchema.parse(found) }
  }
}

/** A store failure, for the paths that must refuse rather than report a short list. */
export function storeUnavailable(store: string): Result<never> {
  return {
    ok: false,
    error: createContractError(
      "transient_transport",
      "mesh.reconcile_store_unavailable",
      `The ${store} for this run could not be read. Reconciliation is refused rather than reported as converged for the part of the inventory it did read: an operator reading "converged" for a diff that skipped one dispatch has no way to know.`,
      true,
    ),
  }
}

export { CONTROLLER, EPOCH, OTHER_WORKER, PROJECT, RUN, WORKER, at, iso, dispatchIdSchema, eventIdSchema, nodeIdSchema, sessionIdSchema }

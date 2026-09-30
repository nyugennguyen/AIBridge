import type { Result } from "../../orchestration/errors.js"
import { commandIdSchema, type CommandId } from "../../orchestration/identifiers.js"
import { parseInboxRow } from "./schemas.js"
import type {
  CommandInboxStore,
  InboxRow,
  InboxRowFilter,
  InboxWriteOutcome,
  NewInboxRow,
} from "./types.js"

/**
 * The in-memory store: the specification the durable one is checked against.
 *
 * Same two reasons the lease store's in-memory twin gives, and the second is the
 * one that matters. "Tests and the TUI can run without a database" is necessary
 * and not sufficient. What makes it earn its place is that every semantic in
 * `CommandInboxStore` — convergence onto one row per `commandId`, monotonic
 * gapless accept sequence, one-way idempotent transitions — is written here
 * FIRST, in the shape that makes it obvious, and `tests/unit/mesh/inbox/` runs
 * the same scenarios against both. A durable store whose transaction semantics
 * have drifted from the reference is exactly the defect this pairing exists to
 * prevent, and it is the defect that only appears under concurrency.
 *
 * It is NOT a cache and NOT a fast path. Nothing in production may hold an inbox
 * row in a `Map`: a worker restart would silently forget every accepted command,
 * and the controller's retry would then be answered with "apply it" — which is a
 * duplicate session, the exact defect the plan's retry diagram exists to rule
 * out.
 */
export class InMemoryCommandInboxStore implements CommandInboxStore {
  readonly #rows = new Map<string, InboxRow>()
  #nextSequence = 1

  async accept(row: NewInboxRow): Promise<Result<InboxWriteOutcome>> {
    const existing = this.#rows.get(row.commandId)
    if (existing !== undefined) {
      return { ok: true, value: { written: false, row: existing } }
    }
    const acceptedSequence = this.#nextSequence
    this.#nextSequence += 1
    const stored = parseInboxRow({
      schemaVersion: 2,
      commandId: row.commandId,
      projectId: row.projectId,
      runId: row.runId,
      dispatchId: row.dispatchId,
      targetNodeId: row.targetNodeId,
      controllerNodeId: row.controllerNodeId,
      controllerEpoch: row.controllerEpoch,
      leaseId: row.leaseId,
      commandType: row.commandType,
      payloadDigest: row.payloadDigest,
      semanticFingerprint: row.semanticFingerprint,
      commandJson: row.commandJson,
      effectState: "not_started",
      acceptedAt: row.acceptedAt,
      acceptedSequence,
      runtimeAcceptedAt: null,
      resultJson: null,
      ackEmittedAt: null,
    })
    // The row is validated BEFORE it is stored, exactly as a row read back from
    // SQLite is. A store that admitted a row its own schema would refuse would make
    // "the schema is enforced" true of the durable store and false of this one.
    if (!stored.ok) return stored
    this.#rows.set(row.commandId, stored.value)
    return { ok: true, value: { written: true, row: stored.value } }
  }

  async find(commandId: CommandId): Promise<Result<InboxRow | null>> {
    return { ok: true, value: this.#rows.get(commandId) ?? null }
  }

  async listInbox(filter: InboxRowFilter = {}): Promise<Result<readonly InboxRow[]>> {
    const all = [...this.#rows.values()]
      .filter((row) => matches(row, filter))
      .sort((a, b) => a.acceptedSequence - b.acceptedSequence)
    return { ok: true, value: Object.freeze(filter.limit === undefined ? all : all.slice(0, filter.limit)) }
  }

  async countInbox(filter: InboxRowFilter = {}): Promise<Result<number>> {
    const all = [...this.#rows.values()].filter((row) => matches(row, filter))
    return { ok: true, value: all.length }
  }

  async markRuntimeAccepted(commandId: CommandId, now: number) {
    const row = this.#rows.get(commandId)
    if (row === undefined) return { ok: true as const, value: null }
    // Only from `not_started`. A redelivery reaching this write twice records the
    // FIRST instant, because which instant an ambiguous launch happened at is the
    // only content the state has.
    if (row.effectState !== "not_started") return { ok: true as const, value: row }
    const next = replace(row, { effectState: "runtime_accepted", runtimeAcceptedAt: now })
    this.#rows.set(commandId, next)
    return { ok: true as const, value: next }
  }

  async recordResult(commandId: CommandId, result: unknown, now: number) {
    void now
    const row = this.#rows.get(commandId)
    if (row === undefined) return { ok: true as const, value: null }
    if (row.effectState === "result_recorded") return { ok: true as const, value: row }
    const next = replace(row, {
      effectState: "result_recorded",
      resultJson: JSON.stringify(result === undefined ? null : result),
    })
    this.#rows.set(commandId, next)
    return { ok: true as const, value: next }
  }

  async markAckEmitted(commandId: CommandId, now: number) {
    const row = this.#rows.get(commandId)
    if (row === undefined) return { ok: true as const, value: null }
    if (row.ackEmittedAt !== null) return { ok: true as const, value: row }
    const next = replace(row, { ackEmittedAt: now })
    this.#rows.set(commandId, next)
    return { ok: true as const, value: next }
  }

  async nextAcceptedSequence(): Promise<Result<number>> {
    return { ok: true, value: this.#nextSequence }
  }
}

/**
 * Replaces a row's members and RE-VALIDATES.
 *
 * The re-validation is the point of this function existing rather than an object
 * spread at each call site. A transition that could produce a row its own schema
 * refuses — `result_recorded` with no `resultJson`, say — would be caught on the
 * next read in the durable store and never here, which would make the two
 * implementations disagree about the one property they exist to agree on.
 */
function replace(row: InboxRow, changes: Partial<InboxRow>): InboxRow {
  const next = parseInboxRow({ ...row, ...changes })
  if (!next.ok) {
    throw new Error(`in-memory inbox transition produced an invalid row: ${next.error.message}`)
  }
  return next.value
}

function matches(row: InboxRow, filter: InboxRowFilter): boolean {
  if (filter.projectId !== undefined && row.projectId !== filter.projectId) return false
  if (filter.runId !== undefined && row.runId !== filter.runId) return false
  if (filter.commandId !== undefined && row.commandId !== filter.commandId) return false
  if (filter.effectState !== undefined && row.effectState !== filter.effectState) return false
  return true
}

export { commandIdSchema }
